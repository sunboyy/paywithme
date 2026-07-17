// SERVER-DERIVED idempotency over a SLIDING window — the Connector's guard against
// an agent that retries a write (ADR-0005, issue #33).
//
// ── Why this exists at all ───────────────────────────────────────────────────
// `/api/v1` creates are idempotent only when the CALLER sends an `Idempotency-Key`
// header (§16.6). MCP has no such caller: `tools/call` carries only the arguments
// the model generated, the model will not mint and persist a UUID across a retry,
// and the transport will not add one. So a naive `create_transaction` is
// at-least-once — into a MONEY LEDGER. The realistic failure is not the network, it
// is the agent: the response is slow, or errors AFTER the write committed, or the
// model misreads it → "That didn't seem to go through, let me try again." → two
// ฿240 lunches, and a dispute in a shared ledger.
//
// The fix: the SERVER derives the key the agent cannot, and routes the create
// through the EXISTING `withIdempotency` store (#20). No new persistence.
//
//   key = sha256( keyId | groupId | toolName | canonicalJson(args) | window )
//
// ── The domain constraint that rules out a naive content hash ────────────────
// Duplicate expenses are LEGITIMATE. Two ฿60 coffees on the same day, same group,
// same title, is normal human behaviour. A pure content hash would silently swallow
// the second one, report "already recorded", and quietly UNDER-BILL the user. The
// mechanism must separate *the same intent, retried* from *the same expense, twice*
// — and TIME is the only signal available. Hence a window.
//
// ── The window SLIDES; it does not bucket ────────────────────────────────────
// A naive `floor(now / 60s)` is a BUCKET, and a bucket is defeated by the exact
// case this mechanism exists to stop: a retry straddling a boundary (t=59s, t=61s)
// lands in a different bucket and duplicates anyway. So we check the CURRENT bucket
// and the PREVIOUS one (ADR-0005).
//
// Two buckets alone, though, would make the window WOBBLE between 60s and 120s: at
// t=119s the previous bucket still holds a row written at t=1s — 118 seconds ago,
// long past any plausible retry, and a legitimate second coffee would be swallowed.
// So a previous-bucket hit is honored only if it is genuinely within the window by
// ELAPSED time (`createdAt`). Bucketing finds the candidate; the clock decides. That
// makes the guard a true 60s sliding window in both directions:
//
//   - retry ≤60s later  → ALWAYS deduplicated. Either it lands in the same bucket,
//     or (since a bucket is exactly one window wide) in the immediately previous one,
//     where the elapsed-time check passes. It can never reach two buckets back.
//   - identical create >60s later → ALWAYS a NEW transaction. The second coffee is
//     recorded, as it must be.

import { createHash } from 'node:crypto';
import {
	withIdempotency,
	IdempotencyConflictError,
	type IdempotencyRecord,
	type IdempotencyStore,
	type IdempotentResponse
} from '$lib/server/api/idempotency';

/**
 * How long a content-identical MCP write is treated as a RETRY rather than a new
 * expense.
 *
 * This number is a JUDGEMENT CALL, not a derived value. Nothing computes it and no
 * measurement produced it. It is meant to be short enough that a genuinely repeated
 * purchase (the second ฿60 coffee) gets through, and long enough to absorb an agent
 * retry after a slow or half-failed call. If real usage shows either failure mode —
 * duplicates slipping through, or legitimate repeats being swallowed — THIS IS THE
 * DIAL (ADR-0005).
 */
export const MCP_IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * Serialize `value` so that logically identical arguments always produce identical
 * bytes — object key ORDER must not change the hash, because `{groupId, amount}` and
 * `{amount, groupId}` are the same intent, and a model does not emit a stable key
 * order across a retry. Keys are sorted recursively; arrays keep their order (an
 * array's order IS meaning — `splitBetween: [a, b]` is the same set as `[b, a]`, but
 * sorting it here would be a domain claim this module has no business making).
 *
 * `undefined` object properties are dropped, mirroring `JSON.stringify`, so an
 * omitted optional and an explicit `undefined` hash alike — they mean the same thing
 * to the tool's Zod schema.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
	return `{${entries.join(',')}}`;
}

/**
 * The ADR-0005 key, for ONE window bucket:
 * `sha256( keyId | groupId | toolName | canonicalJson(args) | window )`.
 *
 * Every component narrows what may collide: `keyId` scopes the key to the CALLING
 * key (as §16.6 requires — one key's writes can never dedup against another's),
 * `groupId` keeps an identical expense in two groups distinct, `toolName` keeps two
 * tools' identical argument shapes apart, and `bucket` is what lets the same expense
 * be recorded again later.
 */
export function deriveIdempotencyKey({
	keyId,
	groupId,
	toolName,
	args,
	bucket
}: {
	keyId: string;
	groupId: string;
	toolName: string;
	args: unknown;
	bucket: number;
}): string {
	// `|` as the separator, over values that are ids / a tool name / JSON — none of
	// which can contain a raw `|` in a way that would let two different tuples render
	// to the same string (the JSON blob is the only free-text component, and it
	// escapes).
	const material = [keyId, groupId, toolName, canonicalJson(args), String(bucket)].join('|');
	return createHash('sha256').update(material).digest('hex');
}

/** The outcome of an idempotent MCP write. */
export interface DerivedIdempotencyOutcome {
	/** The response — freshly produced by `fn`, or replayed from the store. */
	response: IdempotentResponse;
	/**
	 * `null` when `fn` actually RAN. Otherwise how long ago the original create
	 * landed, in ms — the "3 seconds" in "already recorded 3s ago". A replay is
	 * SURFACED to the agent, never hidden (ADR-0005).
	 */
	replayedAfterMs: number | null;
}

/**
 * Run `fn` at most once per (calling key + group + tool + arguments) within the
 * ~60s sliding window, via the existing `withIdempotency` store (ADR-0005).
 *
 * The order of the two checks is the load-bearing part:
 *
 *   1. The PREVIOUS bucket, by a pure `load` — never an insert. This is the
 *      boundary-straddling retry (written at t=59s, retried at t=61s), and it must
 *      be asked FIRST: going to the current bucket first would insert a pending row
 *      and run the create, duplicating exactly the write we are here to stop. A hit
 *      counts only if it is within the window by ELAPSED time (see the header).
 *   2. The CURRENT bucket, through `withIdempotency` — pending-first insert under
 *      the unique constraint, so concurrent retries race safely and the loser sees
 *      `in_progress` rather than both running the create (§16.6).
 *
 * Neither hit → `fn` runs, exactly once, and its response is stored for the rest of
 * the window.
 *
 * Pure aside from the injected `store` and `now`, so every branch — including the
 * boundary case — unit-tests without a database.
 */
export async function withDerivedIdempotency({
	keyId,
	groupId,
	toolName,
	args,
	store,
	fn,
	now = () => new Date()
}: {
	keyId: string;
	groupId: string;
	toolName: string;
	args: unknown;
	store: IdempotencyStore;
	fn: () => Promise<IdempotentResponse>;
	now?: () => Date;
}): Promise<DerivedIdempotencyOutcome> {
	const at = now();
	const bucket = Math.floor(at.getTime() / MCP_IDEMPOTENCY_WINDOW_MS);
	const derive = (b: number) => deriveIdempotencyKey({ keyId, groupId, toolName, args, bucket: b });

	// The body fingerprint `withIdempotency` stores. The DERIVED KEY already encodes
	// these exact bytes, so a row found under a given key was necessarily written with
	// identical arguments → the hash ALWAYS matches → `key_reused` (same key, different
	// body) is structurally unreachable on this path, short of a SHA-256 collision. We
	// still feed the real canonical body rather than a constant: the stored fingerprint
	// stays meaningful, and the `key_reused` branch remains a genuine backstop instead
	// of being disarmed. (`mapToolError` maps it regardless — an agent must never meet
	// an opaque error, ADR-0009.)
	const rawBody = canonicalJson(args);

	// ── 1. The PREVIOUS bucket — the straddling retry. Load only, never insert.
	const previous = await store.load(keyId, derive(bucket - 1));
	if (previous && at.getTime() - previous.createdAt.getTime() <= MCP_IDEMPOTENCY_WINDOW_MS) {
		if (previous.status === 'completed') {
			return {
				response: { status: previous.responseStatus ?? 200, body: previous.responseBody },
				replayedAfterMs: at.getTime() - previous.createdAt.getTime()
			};
		}
		// Still pending: a concurrent retry that straddles the boundary. The original is
		// in flight — running the create now would duplicate it.
		throw new IdempotencyConflictError('in_progress');
	}
	// A previous-bucket row OLDER than the window is deliberately ignored: it is a
	// genuinely repeated expense, and falling through records it (the second coffee).

	// ── 2. The CURRENT bucket — pending-first, so concurrent retries race safely.
	const replayed: { record: IdempotencyRecord | null } = { record: null };
	const response = await withIdempotency({
		keyId,
		idempotencyKey: derive(bucket),
		rawBody,
		store,
		fn,
		// The SAME instant the buckets were derived from — a `now()` that drifted across
		// the boundary mid-call would file the pending row in a bucket this call never
		// checked, leaving it invisible to the next retry.
		now: () => at,
		onReplay: (record) => {
			replayed.record = record;
		}
	});

	const record = replayed.record;
	if (!record) return { response, replayedAfterMs: null };
	// Clamped at 0: a stored `createdAt` marginally in the future (clock skew between
	// app instances) must not report a NEGATIVE age to the agent.
	return {
		response,
		replayedAfterMs: Math.max(0, at.getTime() - record.createdAt.getTime())
	};
}
