import { pgTable, text, integer, bigint } from 'drizzle-orm/pg-core';

// Drizzle table backing the §16.7 TIER-2 (primary, class-aware) API-key rate
// limiter for `/api/v1` traffic.
//
// WHY A SEPARATE TABLE (not better-auth's `rate_limit`): the IP+path limiter in
// `auth.ts` does NOT run for `/api/v1` (the guard calls `verifyApiKey` as a
// server-side function, bypassing `auth.handler`) and can't be keyed per-key. So
// §16.7 defines two tiers, both per KEY. Tier 1 is the plugin's own built-in
// per-key counter (one combined bucket, sized as a generous 150/60s backstop —
// see `auth.ts`). Tier 2 (primary) lives HERE: two INDEPENDENT counters per key,
// `read` (100/60s) and `write` (20/60s), enforced in the route layer after
// `verifyApiKey` + the 403 scope check.
//
// SHAPE mirrors better-auth's own `rate_limit` table (`db/rate-limit-schema.ts`)
// exactly — `id` PK, `key` unique text, `count` int, `lastRequest` bigint-ms — so
// the same atomic conditional-increment / window-reset pattern the plugin uses
// applies unchanged. The lookup `key` is `` `${apiKeyId}:${class}` `` where
// `class` ∈ {`read`,`write`} (the §16.2 read/write split of the REQUEST endpoint,
// NOT the key's own scope), so each key owns two disjoint rows.
//
// Like the sibling hand-authored `rate_limit` / `api_key` / `idempotency_key`
// tables, this lives in its own file and is re-exported from `schema.ts`: the
// `@better-auth/cli generate` step can't resolve the `$app/server` import that
// `auth.ts` pulls in, so it can't emit this table for us. This table is OURS (not
// a better-auth model), so no adapter export-key constraint applies — the const
// name is `apiKeyClassRateLimit` for readability and the SQL name is
// `api_key_class_rate_limit`.
export const apiKeyClassRateLimit = pgTable('api_key_class_rate_limit', {
	id: text('id').primaryKey(),
	// Lookup column: `` `${apiKeyId}:${class}` `` (class ∈ read|write). UNIQUE so
	// the atomic upsert (`onConflictDoUpdate`) can target the single row per
	// (key, class) and the find-by-key read is indexed.
	key: text('key').notNull().unique(),
	// Request count within the current 60s window; conditionally incremented (or
	// reset to 1 when the window has rolled over) by `consumeRateLimit`.
	count: integer('count').notNull(),
	// Millisecond epoch of the window's first request. `mode: 'number'` matches the
	// `rate_limit` convention and the ms-epoch arithmetic in `api/rate-limit.ts`.
	lastRequest: bigint('last_request', { mode: 'number' }).notNull()
});
