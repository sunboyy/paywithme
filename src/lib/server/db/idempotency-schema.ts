import { pgTable, text, integer, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';
import { apikey } from './api-key-schema';

// Hand-authored store table backing `/api/v1` write idempotency (PLAN §16.6).
//
// An `Idempotency-Key` request header on a POST create maps a
// (calling API-key id + client key + request fingerprint) tuple to the response
// that was produced the FIRST time, so a retry REPLAYS that stored response
// instead of re-executing the create — no duplicate transaction, no duplicate
// `audit_log` row. Same pattern as the sibling hand-authored `rate_limit` /
// `api_key` tables (the CLI can't generate them for this config), so this lives in
// its own file and is re-exported from `schema.ts`.
//
// PENDING-FIRST UNDER A UNIQUE CONSTRAINT (§16.6): the row is inserted with
// `status = 'pending'` BEFORE the create runs. The UNIQUE constraint on
// `(key_id, idempotency_key)` means two concurrent retries race on the INSERT —
// exactly one wins and runs the create; the loser's insert violates the constraint
// and, seeing a still-`pending` row, returns 409 (request in progress). Once the
// winner finishes it flips the row to `completed` and stores the response; a later
// retry with the SAME body replays it, a retry with a DIFFERENT body → 409
// (key reused). Scoped to the CALLING KEY via `key_id` so one key's keys can never
// collide with another's.
//
// 24h TTL: `expires_at` = insert time + 24h. `cleanupExpiredIdempotencyKeys`
// (`$lib/server/api/idempotency`) deletes rows past it so the store stays bounded.
//
// COLUMN-TYPE NOTES:
//   - `response_body` is `jsonb` (a raw object, like `audit_log.metadata`) — the
//     stored DTO is a plain object, so jsonb avoids a stringify/parse round-trip
//     and lets the replay hand the object straight back to `json()`.
//   - `key_id` → `api_key.id` is `onDelete: 'cascade'`: a key's idempotency rows go
//     with it when the key is deleted (they are meaningless without the key).
export const idempotencyKey = pgTable(
	'idempotency_key',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		// The CALLING API key's id — scopes every row to its owning key (§16.6).
		keyId: text('key_id')
			.notNull()
			.references(() => apikey.id, { onDelete: 'cascade' }),
		// The client-supplied `Idempotency-Key` header value.
		idempotencyKey: text('idempotency_key').notNull(),
		// Fingerprint of the request body (SHA-256 hex) → a DIFFERENT body under the
		// same key is detectable → 409 (key reused).
		requestHash: text('request_hash').notNull(),
		// Lifecycle: 'pending' (insert, create in flight) → 'completed' (response stored).
		status: text('status').notNull().default('pending'),
		// The stored response, populated when the row flips to 'completed'.
		responseStatus: integer('response_status'),
		responseBody: jsonb('response_body'),
		// Insert time + the 24h TTL expiry the cleanup sweeps on.
		createdAt: timestamp('created_at').defaultNow().notNull(),
		expiresAt: timestamp('expires_at').notNull()
	},
	(table) => [
		// PENDING-FIRST race guard (§16.6): only one row per (calling key, client key)
		// can exist, so the concurrent-retry insert loses and returns 409.
		unique('idempotency_key_key_id_key_unq').on(table.keyId, table.idempotencyKey)
	]
);
