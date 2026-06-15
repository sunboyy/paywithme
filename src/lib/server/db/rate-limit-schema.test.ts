import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { rateLimit } from './rate-limit-schema';
import * as schema from './schema';

// Import-level shape assertions for the Drizzle table backing better-auth's
// DATABASE-backed rate limiting (PLAN §12, task 2.11 hardening). No DB
// connection: we inspect the table object directly so an accidental rename of a
// property/column — which would make the DB-backed limiter silently fail to
// count — is caught at unit time.
describe('rateLimit drizzle table', () => {
	it('maps to the singular `rate_limit` SQL table', () => {
		// `usePlural` is off in our adapter, so the SQL name stays singular.
		expect(getTableName(rateLimit)).toBe('rate_limit');
	});

	it('exports exactly the columns better-auth expects (key/count/lastRequest + id)', () => {
		const columns = getTableColumns(rateLimit);
		// Property keys (camelCase) are what the drizzle adapter looks up by the
		// better-auth field names `key` / `count` / `lastRequest`, plus the `id` PK.
		expect(Object.keys(columns).sort()).toEqual(['count', 'id', 'key', 'lastRequest']);
	});

	it('maps property keys to the expected snake_case columns and types', () => {
		const columns = getTableColumns(rateLimit);
		expect(columns.id.name).toBe('id');
		expect(columns.id.primary).toBe(true);

		// `key` is the lookup column: required + unique per better-auth's spec.
		expect(columns.key.name).toBe('key');
		expect(columns.key.notNull).toBe(true);
		expect(columns.key.isUnique).toBe(true);

		// `count` is the per-window request counter (integer), required.
		expect(columns.count.name).toBe('count');
		expect(columns.count.notNull).toBe(true);
		expect(columns.count.columnType).toBe('PgInteger');

		// `lastRequest` is the ms-epoch timestamp: bigint column, number mode,
		// required (the `last_request` snake_case column).
		expect(columns.lastRequest.name).toBe('last_request');
		expect(columns.lastRequest.notNull).toBe(true);
		expect(columns.lastRequest.columnType).toBe('PgBigInt53');
	});

	it('is re-exported from the schema entry point under the `rateLimit` key', () => {
		// The drizzle adapter resolves the better-auth `rateLimit` model via
		// `schema['rateLimit']`, so this key MUST be present in the schema object
		// passed to `drizzle(pool, { schema })` and to drizzle-kit.
		expect((schema as Record<string, unknown>).rateLimit).toBe(rateLimit);
	});
});
