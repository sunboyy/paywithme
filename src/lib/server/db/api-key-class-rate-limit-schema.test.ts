import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { apiKeyClassRateLimit } from './api-key-class-rate-limit-schema';
import * as schema from './schema';

// Import-level shape assertions for the Drizzle table backing the §16.7 TIER-2
// per-key, class-aware rate limiter. No DB connection: we inspect the table
// object directly so an accidental rename of a property/column — which would make
// the atomic conditional-increment silently fail to count — is caught at unit
// time. Mirrors `rate-limit-schema.test.ts` (the shape it deliberately copies).
describe('apiKeyClassRateLimit drizzle table', () => {
	it('maps to the `api_key_class_rate_limit` SQL table', () => {
		expect(getTableName(apiKeyClassRateLimit)).toBe('api_key_class_rate_limit');
	});

	it('exports exactly the 4 columns mirrored from `rate_limit` (key/count/lastRequest + id)', () => {
		const columns = getTableColumns(apiKeyClassRateLimit);
		expect(Object.keys(columns).sort()).toEqual(['count', 'id', 'key', 'lastRequest']);
	});

	it('maps property keys to the expected snake_case columns and types', () => {
		const columns = getTableColumns(apiKeyClassRateLimit);
		expect(columns.id.name).toBe('id');
		expect(columns.id.primary).toBe(true);

		// `key` is the `${apiKeyId}:${class}` lookup column: required + unique so the
		// atomic upsert can target the single row per (key, class).
		expect(columns.key.name).toBe('key');
		expect(columns.key.notNull).toBe(true);
		expect(columns.key.isUnique).toBe(true);

		// `count` is the per-window request counter (integer), required.
		expect(columns.count.name).toBe('count');
		expect(columns.count.notNull).toBe(true);
		expect(columns.count.columnType).toBe('PgInteger');

		// `lastRequest` is the ms-epoch of the window start: bigint, number mode.
		expect(columns.lastRequest.name).toBe('last_request');
		expect(columns.lastRequest.notNull).toBe(true);
		expect(columns.lastRequest.columnType).toBe('PgBigInt53');
	});

	it('is re-exported from the schema entry point so `drizzle(pool, { schema })` picks it up', () => {
		expect((schema as Record<string, unknown>).apiKeyClassRateLimit).toBe(apiKeyClassRateLimit);
	});
});
