// `/api/v1` write idempotency — replay / 409 / pending-first race (PLAN §16.6).
//
// An `Idempotency-Key` request header on a POST create (`…/transactions`,
// `…/settle-up`) is OPTIONAL but strongly recommended. When present, the create is
// run AT MOST ONCE per (calling key + client key + request body): a retry with the
// SAME body replays the stored response (re-executing nothing → no duplicate
// transaction, no duplicate `audit_log` row); the same key with a DIFFERENT body is
// a 409 (key reused); a concurrent retry that loses the pending-first insert race is
// a 409 (request in progress). Absent header → the current at-least-once behavior
// (a retry may create a duplicate) — the route simply doesn't call in here.
//
// This module owns the SEMANTICS (pure, store-injected → unit-testable) and the
// production Drizzle store (`createDbIdempotencyStore`). The two POST routes share
// it via {@link withIdempotency} so the logic lives in ONE place. The idempotency
// key is the SOLE dedup guard (§16.6) — no fuzzy dedup, no client id.

import { createHash } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { idempotencyKey as idempotencyKeyTable } from '$lib/server/db/idempotency-schema';

/** How long a stored idempotency record is honored before TTL cleanup (24h, §16.6). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** The response an idempotent create produces / replays: an HTTP status + JSON body. */
export interface IdempotentResponse {
	status: number;
	/** JSON-serializable response body — stored verbatim in `response_body` (jsonb). */
	body: unknown;
}

/** A stored idempotency row as the semantics layer needs to read it back. */
export interface IdempotencyRecord {
	requestHash: string;
	status: 'pending' | 'completed';
	responseStatus: number | null;
	responseBody: unknown;
	/**
	 * When the row was inserted — i.e. when the create it guards actually ran.
	 *
	 * REST ignores this (a replay is a replay, whenever it arrives, for the full 24h
	 * TTL). The MCP path (ADR-0005) needs it twice: to enforce its ~60s SLIDING window
	 * by ELAPSED time rather than by bucket arithmetic, and to tell the agent how long
	 * ago the original landed ("already recorded 3s ago"). Projecting an existing
	 * column — no schema change.
	 */
	createdAt: Date;
}

/** The row the pending-first insert writes. */
export interface PendingInsert {
	keyId: string;
	idempotencyKey: string;
	requestHash: string;
	createdAt: Date;
	expiresAt: Date;
}

/**
 * The persistence seam {@link withIdempotency} drives. Injected in unit tests with a
 * stub; backed by Postgres in production via {@link createDbIdempotencyStore}.
 */
export interface IdempotencyStore {
	/**
	 * Insert a `pending` row. Returns `true` if THIS caller won the pending-first
	 * insert (it must now run the create), or `false` if the UNIQUE
	 * `(key_id, idempotency_key)` constraint was violated (a row already exists — a
	 * replay or a concurrent retry).
	 */
	insertPending(row: PendingInsert): Promise<boolean>;
	/** Load the existing row for `(keyId, idempotencyKey)`, or `null` if none. */
	load(keyId: string, idempotencyKey: string): Promise<IdempotencyRecord | null>;
	/** Flip the row to `completed` and store the produced response. */
	markCompleted(keyId: string, idempotencyKey: string, response: IdempotentResponse): Promise<void>;
}

/**
 * An idempotency conflict (§16.6) → 409 `conflict`. `reason` distinguishes the two
 * sub-cases; `mapWriteError` (`write.ts`) turns it into the 409 envelope with
 * `details.reason`.
 *   - `key_reused`  — the same `Idempotency-Key` was replayed with a DIFFERENT body.
 *   - `in_progress` — a concurrent retry is still running (the row is `pending`).
 */
export class IdempotencyConflictError extends Error {
	readonly code = 'idempotency_conflict' as const;
	constructor(readonly reason: 'key_reused' | 'in_progress') {
		super(
			reason === 'key_reused'
				? 'This Idempotency-Key was already used with a different request body.'
				: 'A request with this Idempotency-Key is already in progress.'
		);
		this.name = 'IdempotencyConflictError';
	}
}

/** SHA-256 hex of the raw request body — the §16.6 request fingerprint. */
export function fingerprintRequestBody(rawBody: string): string {
	return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Run `fn` AT MOST ONCE for a given `(keyId, idempotencyKey, rawBody)` (§16.6).
 *
 * Flow:
 *   1. Fingerprint the raw body and try the PENDING-FIRST insert.
 *   2. WON the insert → run `fn`, store its `{status, body}`, mark the row
 *      `completed`, and return the response. `fn` runs exactly once, so the create
 *      + its audit row happen once.
 *   3. LOST the insert (row already exists) → load it:
 *        - `completed` + matching hash → REPLAY the stored response (re-run nothing).
 *        - hash differs (whether pending or completed) → 409 `key_reused`.
 *        - still `pending` (same hash) → 409 `in_progress` (a concurrent retry).
 *
 * Pure aside from the injected `store`, so the three outcomes unit-test directly.
 */
export async function withIdempotency({
	keyId,
	idempotencyKey,
	rawBody,
	store,
	fn,
	now = () => new Date(),
	onReplay
}: {
	keyId: string;
	idempotencyKey: string;
	rawBody: string;
	store: IdempotencyStore;
	fn: () => Promise<IdempotentResponse>;
	now?: () => Date;
	/**
	 * Called with the STORED row when this call REPLAYED it (and therefore did NOT
	 * run `fn`). The return value is unchanged either way — this is a notification,
	 * not a hook that can alter the outcome.
	 *
	 * REST does not pass it: a replayed 201 is byte-identical to the original, which
	 * is the entire contract. The MCP path (ADR-0005) does, because there a replay
	 * must be SURFACED rather than hidden — the echo-back says "already recorded 3s
	 * ago", and `record.createdAt` is where that "3s" comes from. Reported here rather
	 * than re-`load`ed by the caller so the replay stays ONE round-trip.
	 */
	onReplay?: (record: IdempotencyRecord) => void;
}): Promise<IdempotentResponse> {
	const requestHash = fingerprintRequestBody(rawBody);
	const createdAt = now();
	const expiresAt = new Date(createdAt.getTime() + IDEMPOTENCY_TTL_MS);

	const won = await store.insertPending({
		keyId,
		idempotencyKey,
		requestHash,
		createdAt,
		expiresAt
	});

	// We won the pending-first insert → run the create ONCE and store the response.
	if (won) {
		const response = await fn();
		await store.markCompleted(keyId, idempotencyKey, response);
		return response;
	}

	// Lost the race (or this is a later retry): a row already exists. Decide replay
	// vs 409 from its stored state.
	const existing = await store.load(keyId, idempotencyKey);
	if (!existing) {
		// The row vanished between the failed insert and this read (e.g. TTL cleanup
		// raced us). Treat as still-in-flight rather than inventing a response.
		throw new IdempotencyConflictError('in_progress');
	}

	// Same key, DIFFERENT body → key reuse, regardless of pending/completed (§16.6).
	if (existing.requestHash !== requestHash) {
		throw new IdempotencyConflictError('key_reused');
	}

	// Same key + same body, already completed → REPLAY (re-execute nothing).
	if (existing.status === 'completed') {
		onReplay?.(existing);
		return { status: existing.responseStatus ?? 200, body: existing.responseBody };
	}

	// Same key + same body, still pending → a concurrent retry is in progress.
	throw new IdempotencyConflictError('in_progress');
}

/**
 * A Postgres unique-violation (`23505`) — the pending-first insert lost the race.
 *
 * The code is looked up along the CAUSE CHAIN, not just on the thrown value: Drizzle
 * wraps every driver failure in a `DrizzleQueryError` whose own `code` is undefined
 * and whose `cause` is the `pg` error carrying `code: '23505'`. Checking only the
 * top-level object made the duplicate insert escape as an uncaught error — i.e. a
 * REPLAY (§16.6) surfaced as a 500 instead of the stored response. Only a real-DB
 * test can catch that (a stubbed store throws whatever it is told to), which is why
 * `tests/integration/api-idempotency-rate-limit.test.ts` exists.
 */
function isUniqueViolation(e: unknown): boolean {
	const UNIQUE_VIOLATION = '23505';
	// Bounded walk — a cause chain is short, and the bound rules out a cycle.
	for (let current: unknown = e, depth = 0; current != null && depth < 5; depth++) {
		if (typeof current === 'object' && 'code' in current) {
			if ((current as { code: unknown }).code === UNIQUE_VIOLATION) return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * The production {@link IdempotencyStore} over the Drizzle `db`. The pending-first
 * insert relies on the UNIQUE `(key_id, idempotency_key)` constraint: a duplicate
 * insert throws `23505`, which we translate to `insertPending → false`.
 */
export function createDbIdempotencyStore(): IdempotencyStore {
	return {
		async insertPending(row) {
			try {
				await db.insert(idempotencyKeyTable).values({
					keyId: row.keyId,
					idempotencyKey: row.idempotencyKey,
					requestHash: row.requestHash,
					status: 'pending',
					createdAt: row.createdAt,
					expiresAt: row.expiresAt
				});
				return true;
			} catch (e) {
				if (isUniqueViolation(e)) return false;
				throw e;
			}
		},
		async load(keyId, key) {
			const rows = await db
				.select({
					requestHash: idempotencyKeyTable.requestHash,
					status: idempotencyKeyTable.status,
					responseStatus: idempotencyKeyTable.responseStatus,
					responseBody: idempotencyKeyTable.responseBody,
					// The insert time — the MCP sliding window measures elapsed time against it
					// and the replay echo-back reports it (ADR-0005). An existing column.
					createdAt: idempotencyKeyTable.createdAt
				})
				.from(idempotencyKeyTable)
				.where(
					and(eq(idempotencyKeyTable.keyId, keyId), eq(idempotencyKeyTable.idempotencyKey, key))
				)
				.limit(1);
			const row = rows[0];
			if (!row) return null;
			return {
				requestHash: row.requestHash,
				status: row.status as 'pending' | 'completed',
				responseStatus: row.responseStatus,
				responseBody: row.responseBody,
				createdAt: row.createdAt
			};
		},
		async markCompleted(keyId, key, response) {
			await db
				.update(idempotencyKeyTable)
				.set({
					status: 'completed',
					responseStatus: response.status,
					responseBody: response.body
				})
				.where(
					and(eq(idempotencyKeyTable.keyId, keyId), eq(idempotencyKeyTable.idempotencyKey, key))
				);
		}
	};
}

/**
 * Delete every idempotency row whose 24h TTL has passed (`expires_at <= now`),
 * keeping the store bounded (§16.6). No scheduler in this ticket — call it from a
 * sweep/cron later. Returns nothing; failures propagate to the caller.
 */
export async function cleanupExpiredIdempotencyKeys(now: Date = new Date()): Promise<void> {
	await db.delete(idempotencyKeyTable).where(lte(idempotencyKeyTable.expiresAt, now));
}
