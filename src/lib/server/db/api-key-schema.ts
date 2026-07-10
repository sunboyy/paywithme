import { pgTable, text, integer, bigint, boolean, timestamp, index } from 'drizzle-orm/pg-core';

// Drizzle table backing the `@better-auth/api-key` plugin (PLAN §16.1).
//
// The plugin (registered in `auth.ts`, task #12) resolves its `apikey` model to
// the Drizzle schema export whose KEY is `apikey` — the drizzle adapter does
// `schema['apikey']` (with `usePlural` off) — so the exported const MUST be named
// `apikey`. The SQL table name (`api_key`) is independent.
//
// This lives in its OWN file, hand-authored, rather than in the CLI-generated
// `auth-schema.ts` (do-not-edit) for the SAME reason as `rate-limit-schema.ts`:
// `@better-auth/cli generate` cannot resolve the `$app/server` import that the
// `sveltekitCookies` plugin pulls into `auth.ts`, so it can't emit this table for
// us. The field shape is mirrored exactly from the plugin's own `apikey` model
// (`apiKeySchema(...)` in `@better-auth/api-key`), using the same conventions as
// the generated `auth-schema.ts`: `text('id').primaryKey()`, camelCase property
// keys mapped to snake_case columns, and `timestamp(...)` for date fields.
//
// COLUMN-TYPE NOTE — the two ms-duration fields `rateLimitTimeWindow` and
// `refillInterval` are `bigint({ mode: 'number' })`, NOT `integer`: a rate-limit
// window / refill interval expressed in MILLISECONDS can exceed the int32 range
// (~24.8 days), so a 32-bit column would overflow. This follows the
// `rate_limit.lastRequest` precedent (also a ms value stored as bigint). The
// plugin reads both back as Numbers, so `mode: 'number'` matches its expectations.
//
// The plugin stores `metadata` and `permissions` as STRINGS (it JSON.stringifies
// `metadata` via its own input/output transform before the value reaches the
// adapter), so both are plain `text` columns here — a `jsonb` column would
// double-encode the already-stringified value. This differs from `audit_log`,
// which stores a raw object in `jsonb`; the choice follows the plugin's declared
// field types, not a blanket convention.
export const apikey = pgTable(
	'api_key',
	{
		id: text('id').primaryKey(),
		// Names the configuration set this key belongs to. The plugin defaults it to
		// `'default'` (required, indexed) and multi-config setups key off it.
		configId: text('config_id').notNull().default('default'),
		// Human-readable label for the key (optional).
		name: text('name'),
		// The first few plaintext characters of the key (incl. its prefix), stored so
		// the UI can identify a key without ever revealing the full secret.
		start: text('start'),
		// The key's plaintext prefix (e.g. `pwm_test_` / `pwm_live_`), stored as-is.
		prefix: text('prefix'),
		// The HASHED key value (SHA-256). Required + indexed: the plugin looks a key up
		// by its hash on every verify.
		key: text('key').notNull(),
		// The id of the owning entity (= userId). Required + indexed for owner lookups.
		referenceId: text('reference_id').notNull(),
		// ── Refill (remaining-count top-up) ────────────────────────────────────────
		// Interval in MILLISECONDS → bigint (can exceed int32). See the column-type
		// note above.
		refillInterval: bigint('refill_interval', { mode: 'number' }),
		refillAmount: integer('refill_amount'),
		lastRefillAt: timestamp('last_refill_at'),
		// ── Enable / rate-limit flags ──────────────────────────────────────────────
		enabled: boolean('enabled').default(true),
		rateLimitEnabled: boolean('rate_limit_enabled').default(true),
		// Rate-limit window in MILLISECONDS → bigint (can exceed int32). See note above.
		rateLimitTimeWindow: bigint('rate_limit_time_window', { mode: 'number' }),
		rateLimitMax: integer('rate_limit_max'),
		// ── Usage counters ─────────────────────────────────────────────────────────
		requestCount: integer('request_count'),
		remaining: integer('remaining'),
		lastRequest: timestamp('last_request'),
		// ── Lifecycle ──────────────────────────────────────────────────────────────
		expiresAt: timestamp('expires_at'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
		// JSON stored as a STRING by the plugin (see the header note) — text, not jsonb.
		metadata: text('metadata'),
		permissions: text('permissions')
	},
	(table) => [
		// The plugin marks `configId`, `key` and `referenceId` as indexed fields.
		index('api_key_config_id_idx').on(table.configId),
		index('api_key_key_idx').on(table.key),
		index('api_key_reference_id_idx').on(table.referenceId)
	]
);
