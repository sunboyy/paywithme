import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { apikey } from './api-key-schema';
import * as schema from './schema';

// Import-level shape assertions for the hand-authored Drizzle table backing the
// `@better-auth/api-key` plugin (PLAN §16.1). No DB connection: we inspect the
// table object directly so an accidental rename/retype of a column — which would
// silently break the plugin's store — is caught at unit time.
describe('apikey drizzle table', () => {
	it('maps to the singular `api_key` SQL table', () => {
		// `usePlural` is off in our adapter, so the SQL name stays singular.
		expect(getTableName(apikey)).toBe('api_key');
	});

	it('exports exactly the columns the plugin `apikey` model expects', () => {
		const columns = getTableColumns(apikey);
		// Property keys (camelCase) are what the drizzle adapter looks up by the
		// plugin's field names.
		expect(Object.keys(columns).sort()).toEqual(
			[
				'configId',
				'createdAt',
				'enabled',
				'expiresAt',
				'id',
				'key',
				'lastRefillAt',
				'lastRequest',
				'metadata',
				'name',
				'permissions',
				'prefix',
				'rateLimitEnabled',
				'rateLimitMax',
				'rateLimitTimeWindow',
				'refillAmount',
				'refillInterval',
				'referenceId',
				'remaining',
				'requestCount',
				'start',
				'updatedAt'
			].sort()
		);
	});

	it('stores the two ms-duration fields as bigint (number mode), not int32', () => {
		const columns = getTableColumns(apikey);
		// A rate-limit window / refill interval in MILLISECONDS can exceed int32
		// (~24.8 days), so these MUST be bigint — the `rate_limit` precedent.
		expect(columns.rateLimitTimeWindow.name).toBe('rate_limit_time_window');
		expect(columns.rateLimitTimeWindow.columnType).toBe('PgBigInt53');
		expect(columns.refillInterval.name).toBe('refill_interval');
		expect(columns.refillInterval.columnType).toBe('PgBigInt53');
	});

	it('keeps the small counter/limit fields as int32', () => {
		const columns = getTableColumns(apikey);
		// These are bounded counts, not ms durations, so int32 is correct.
		expect(columns.rateLimitMax.columnType).toBe('PgInteger');
		expect(columns.refillAmount.columnType).toBe('PgInteger');
		expect(columns.requestCount.columnType).toBe('PgInteger');
		expect(columns.remaining.columnType).toBe('PgInteger');
	});

	it('marks id / key / referenceId as the required identifying columns', () => {
		const columns = getTableColumns(apikey);

		expect(columns.id.name).toBe('id');
		expect(columns.id.primary).toBe(true);

		// The hashed key value: required (looked up on every verify).
		expect(columns.key.name).toBe('key');
		expect(columns.key.notNull).toBe(true);

		// The owning entity (= userId): required.
		expect(columns.referenceId.name).toBe('reference_id');
		expect(columns.referenceId.notNull).toBe(true);
	});

	it('gives configId a NOT NULL `default` default', () => {
		const columns = getTableColumns(apikey);
		expect(columns.configId.name).toBe('config_id');
		expect(columns.configId.notNull).toBe(true);
		expect(columns.configId.default).toBe('default');
	});

	it('maps date fields to timestamp columns', () => {
		const columns = getTableColumns(apikey);
		for (const key of [
			'lastRefillAt',
			'lastRequest',
			'expiresAt',
			'createdAt',
			'updatedAt'
		] as const) {
			expect(columns[key].columnType).toBe('PgTimestamp');
		}
	});

	it('stores metadata / permissions as text (plugin stringifies), not jsonb', () => {
		const columns = getTableColumns(apikey);
		// The plugin JSON.stringifies metadata before it reaches the adapter, so a
		// jsonb column would double-encode. permissions is likewise a string field.
		expect(columns.metadata.columnType).toBe('PgText');
		expect(columns.permissions.columnType).toBe('PgText');
	});

	it('is re-exported from the schema entry point under the `apikey` key', () => {
		// The drizzle adapter resolves the plugin's `apikey` model via
		// `schema['apikey']`, so this exact key MUST be present in the schema object
		// passed to `drizzle(pool, { schema })` and to drizzle-kit.
		expect((schema as Record<string, unknown>).apikey).toBe(apikey);
	});
});
