import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { idempotencyKey } from './idempotency-schema';
import * as schema from './schema';

// Import-level shape assertions for the hand-authored idempotency store table
// (PLAN §16.6). No DB connection: we inspect the table object directly so an
// accidental column/constraint rename — which would break the pending-first race
// guard or the replay lookup — is caught at unit time.
describe('idempotencyKey drizzle table', () => {
	it('maps to the `idempotency_key` SQL table', () => {
		expect(getTableName(idempotencyKey)).toBe('idempotency_key');
	});

	it('exports the columns the §16.6 store needs', () => {
		const columns = getTableColumns(idempotencyKey);
		expect(Object.keys(columns).sort()).toEqual([
			'createdAt',
			'expiresAt',
			'id',
			'idempotencyKey',
			'keyId',
			'requestHash',
			'responseBody',
			'responseStatus',
			'status'
		]);
	});

	it('maps property keys to the expected snake_case columns and types', () => {
		const columns = getTableColumns(idempotencyKey);

		expect(columns.id.name).toBe('id');
		expect(columns.id.primary).toBe(true);

		// Scopes every row to the CALLING key (§16.6).
		expect(columns.keyId.name).toBe('key_id');
		expect(columns.keyId.notNull).toBe(true);

		// The client-supplied `Idempotency-Key` header value.
		expect(columns.idempotencyKey.name).toBe('idempotency_key');
		expect(columns.idempotencyKey.notNull).toBe(true);

		// The request fingerprint → detects same-key + different-body (→ 409).
		expect(columns.requestHash.name).toBe('request_hash');
		expect(columns.requestHash.notNull).toBe(true);

		// Pending-first lifecycle: defaults to 'pending'.
		expect(columns.status.name).toBe('status');
		expect(columns.status.notNull).toBe(true);
		expect(columns.status.default).toBe('pending');

		// The stored response (nullable until the row flips to 'completed').
		expect(columns.responseStatus.name).toBe('response_status');
		expect(columns.responseStatus.columnType).toBe('PgInteger');
		expect(columns.responseBody.name).toBe('response_body');
		expect(columns.responseBody.columnType).toBe('PgJsonb');

		// The 24h TTL boundary the cleanup sweeps on.
		expect(columns.expiresAt.name).toBe('expires_at');
		expect(columns.expiresAt.notNull).toBe(true);
		expect(columns.createdAt.name).toBe('created_at');
		expect(columns.createdAt.notNull).toBe(true);
	});

	it('does NOT reference api_key — key_id is an opaque per-caller bucket, not an FK', () => {
		// Regression: an FK `key_id → api_key.id` rejected every OAuth-originated write,
		// whose principal `keyId` is the composed `${clientId}:${userId}` (`mcp/auth.ts`)
		// with no matching `api_key` row — surfacing as an opaque `internal_error`. The
		// column MUST stay FK-free so both credential kinds can insert; the 24h TTL sweep
		// bounds the table without a cascade.
		const { foreignKeys } = getTableConfig(idempotencyKey);
		expect(foreignKeys).toHaveLength(0);
	});

	it('has a UNIQUE (key_id, idempotency_key) constraint — the pending-first race guard', () => {
		const { uniqueConstraints } = getTableConfig(idempotencyKey);
		expect(uniqueConstraints).toHaveLength(1);
		const [unq] = uniqueConstraints;
		expect(unq.name).toBe('idempotency_key_key_id_key_unq');
		expect(unq.columns.map((c) => c.name)).toEqual(['key_id', 'idempotency_key']);
	});

	it('is re-exported from the schema entry point under the `idempotencyKey` key', () => {
		expect((schema as Record<string, unknown>).idempotencyKey).toBe(idempotencyKey);
	});
});
