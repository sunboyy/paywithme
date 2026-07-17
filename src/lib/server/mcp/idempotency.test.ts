import { describe, it, expect, vi } from 'vitest';

// Unit tests for the SERVER-DERIVED idempotency window (ADR-0005, issue #33).
//
// These carry the real weight of the ticket. The mechanism is store-injected and
// clock-injected precisely so its behaviour is provable WITHOUT a database and
// WITHOUT sleeping for a minute: the store stub below is a real in-memory
// implementation of the `(key_id, idempotency_key)` unique constraint the Postgres
// table enforces, so the pending-first race, the replay, and — the case the whole
// mechanism exists for — the BOUNDARY-STRADDLING retry all execute here.
//
// The real-Postgres counterparts live in `tests/integration/mcp-boundary.test.ts`.

import {
	IdempotencyConflictError,
	type IdempotencyRecord,
	type IdempotencyStore,
	type IdempotentResponse
} from '$lib/server/api/idempotency';
import {
	canonicalJson,
	deriveIdempotencyKey,
	withDerivedIdempotency,
	MCP_IDEMPOTENCY_WINDOW_MS
} from './idempotency';

/**
 * An in-memory `IdempotencyStore` that enforces the SAME unique constraint the real
 * table does: the second `insertPending` for a `(keyId, key)` pair loses. Faithful
 * enough that the semantics under test are the production ones.
 */
function makeStore(): IdempotencyStore & { rows: Map<string, IdempotencyRecord> } {
	const rows = new Map<string, IdempotencyRecord>();
	const at = (keyId: string, key: string) => `${keyId}::${key}`;
	return {
		rows,
		async insertPending(row) {
			const id = at(row.keyId, row.idempotencyKey);
			// The UNIQUE `(key_id, idempotency_key)` constraint: the loser gets `false`.
			if (rows.has(id)) return false;
			rows.set(id, {
				requestHash: row.requestHash,
				status: 'pending',
				responseStatus: null,
				responseBody: null,
				createdAt: row.createdAt
			});
			return true;
		},
		async load(keyId, key) {
			return rows.get(at(keyId, key)) ?? null;
		},
		async markCompleted(keyId, key, response) {
			const existing = rows.get(at(keyId, key));
			if (!existing) return;
			rows.set(at(keyId, key), {
				...existing,
				status: 'completed',
				responseStatus: response.status,
				responseBody: response.body
			});
		}
	};
}

/** The arguments of a ฿240 lunch — the ADR's own example. */
const LUNCH = { groupId: 'grp_1', title: 'Lunch', amount: '240', splitBetween: ['m_1', 'm_2'] };

/** Drive the mechanism at instant `at` with a create that returns a fresh row id. */
async function callAt(
	store: IdempotencyStore,
	at: Date,
	args: unknown = LUNCH,
	fn: () => Promise<IdempotentResponse> = async () => ({ status: 200, body: { id: 'txn_1' } })
) {
	return withDerivedIdempotency({
		keyId: 'key_1',
		groupId: 'grp_1',
		toolName: 'create_transaction',
		args,
		store,
		fn,
		now: () => at
	});
}

const T0 = new Date('2026-07-16T12:00:00.000Z');
/** `T0 + seconds`. */
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('MCP_IDEMPOTENCY_WINDOW_MS', () => {
	it('is the single ~60s dial ADR-0005 describes', () => {
		expect(MCP_IDEMPOTENCY_WINDOW_MS).toBe(60_000);
	});
});

describe('canonicalJson — argument ORDER must not change the hash', () => {
	it('sorts object keys, so `{a,b}` and `{b,a}` are the same intent', () => {
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
		expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
	});

	it('sorts keys RECURSIVELY — a model does not emit nested keys in a stable order', () => {
		const one = { outer: { z: 1, a: { y: 2, b: 3 } } };
		const two = { outer: { a: { b: 3, y: 2 }, z: 1 } };
		expect(canonicalJson(one)).toBe(canonicalJson(two));
	});

	it('sorts keys inside objects nested in ARRAYS', () => {
		expect(canonicalJson([{ b: 1, a: 2 }])).toBe(canonicalJson([{ a: 2, b: 1 }]));
	});

	it('PRESERVES array order — `[a,b]` is not textually `[b,a]`', () => {
		// Deliberate: an array's order is meaning, and re-ordering `splitBetween` is a
		// domain claim this module does not make. Documents the accepted consequence —
		// a retry that re-orders the split list is NOT deduplicated.
		expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
	});

	it('drops `undefined` properties, so an omitted optional hashes like an explicit one', () => {
		expect(canonicalJson({ a: 1, paidBy: undefined })).toBe(canonicalJson({ a: 1 }));
	});

	it('distinguishes values that genuinely differ, including type', () => {
		expect(canonicalJson({ amount: '240' })).not.toBe(canonicalJson({ amount: '250' }));
		expect(canonicalJson({ amount: '240' })).not.toBe(canonicalJson({ amount: 240 }));
	});

	it('handles null, scalars and empty containers without throwing', () => {
		expect(canonicalJson(null)).toBe('null');
		expect(canonicalJson('x')).toBe('"x"');
		expect(canonicalJson(5)).toBe('5');
		expect(canonicalJson({})).toBe('{}');
		expect(canonicalJson([])).toBe('[]');
	});
});

describe('deriveIdempotencyKey — sha256( keyId | groupId | toolName | args | window )', () => {
	const base = { keyId: 'key_1', groupId: 'grp_1', toolName: 'create_transaction', bucket: 7 };

	it('is a sha256 hex digest, deterministic for identical inputs', () => {
		const k = deriveIdempotencyKey({ ...base, args: LUNCH });
		expect(k).toMatch(/^[0-9a-f]{64}$/);
		expect(k).toBe(deriveIdempotencyKey({ ...base, args: LUNCH }));
	});

	it('ignores argument key ORDER — the same intent derives the same key', () => {
		const reordered = {
			splitBetween: ['m_1', 'm_2'],
			amount: '240',
			title: 'Lunch',
			groupId: 'grp_1'
		};
		expect(deriveIdempotencyKey({ ...base, args: reordered })).toBe(
			deriveIdempotencyKey({ ...base, args: LUNCH })
		);
	});

	it('every component narrows the key: a change to ANY of them derives a different one', () => {
		const k = deriveIdempotencyKey({ ...base, args: LUNCH });
		// Scoped to the CALLING key (§16.6) — one key can never dedup against another's.
		expect(deriveIdempotencyKey({ ...base, keyId: 'key_2', args: LUNCH })).not.toBe(k);
		// The same expense in two groups is two expenses.
		expect(deriveIdempotencyKey({ ...base, groupId: 'grp_2', args: LUNCH })).not.toBe(k);
		// Two tools' identical argument shapes stay apart.
		expect(deriveIdempotencyKey({ ...base, toolName: 'settle_up', args: LUNCH })).not.toBe(k);
		// The window is what lets the same expense be recorded again later.
		expect(deriveIdempotencyKey({ ...base, bucket: 8, args: LUNCH })).not.toBe(k);
		// And the arguments themselves.
		expect(deriveIdempotencyKey({ ...base, args: { ...LUNCH, amount: '250' } })).not.toBe(k);
	});
});

describe('withDerivedIdempotency — the retry an agent actually makes', () => {
	it('a first create RUNS, is not flagged as a replay, and is stored for the window', async () => {
		const store = makeStore();
		const fn = vi.fn(
			async (): Promise<IdempotentResponse> => ({ status: 200, body: { id: 't1' } })
		);

		const out = await callAt(store, T0, LUNCH, fn);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(out.replayedAfterMs).toBeNull();
		expect(out.response).toEqual({ status: 200, body: { id: 't1' } });
		expect(store.rows.size).toBe(1);
	});

	it('a content-identical retry INSIDE the window replays: ONE transaction, fn runs once', async () => {
		const store = makeStore();
		const fn = vi.fn(
			async (): Promise<IdempotentResponse> => ({ status: 200, body: { id: 't1' } })
		);

		await callAt(store, T0, LUNCH, fn);
		// "That didn't seem to go through, let me try again." — 3 seconds later.
		const retry = await callAt(store, at(3), LUNCH, fn);

		// The create ran ONCE. No second ฿240 lunch.
		expect(fn).toHaveBeenCalledTimes(1);
		expect(retry.response).toEqual({ status: 200, body: { id: 't1' } });
		// And the replay is REPORTED (the echo-back's "3 seconds ago"), not hidden.
		expect(retry.replayedAfterMs).toBe(3000);
	});

	it('replays regardless of argument ORDER — the model need not be textually stable', async () => {
		const store = makeStore();
		const fn = vi.fn(
			async (): Promise<IdempotentResponse> => ({ status: 200, body: { id: 't1' } })
		);

		await callAt(store, T0, LUNCH, fn);
		const retry = await callAt(
			store,
			at(2),
			{ splitBetween: ['m_1', 'm_2'], title: 'Lunch', amount: '240', groupId: 'grp_1' },
			fn
		);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(retry.replayedAfterMs).toBe(2000);
	});

	it('the SAME EXPENSE after the window is a NEW transaction — the second coffee is recorded', async () => {
		const store = makeStore();
		let n = 0;
		const fn = vi.fn(
			async (): Promise<IdempotentResponse> => ({
				status: 200,
				body: { id: `t${++n}` }
			})
		);

		await callAt(store, T0, LUNCH, fn);
		// An hour later, the user buys the same lunch again. This is NOT a retry.
		const later = await callAt(store, at(3600), LUNCH, fn);

		expect(fn).toHaveBeenCalledTimes(2);
		expect(later.replayedAfterMs).toBeNull();
		expect(later.response.body).toEqual({ id: 't2' });
	});

	it('a DIFFERENT amount inside the window is a new transaction, not a conflict', async () => {
		const store = makeStore();
		const fn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: { id: 'x' } }));

		await callAt(store, T0, LUNCH, fn);
		const other = await callAt(store, at(1), { ...LUNCH, amount: '60' }, fn);

		// Different args → a different derived key → a clean create. `key_reused` (the
		// same key with a different body) is structurally unreachable on this path.
		expect(fn).toHaveBeenCalledTimes(2);
		expect(other.replayedAfterMs).toBeNull();
	});
});

// ── THE CRUX: the window SLIDES, it does not bucket (ADR-0005) ───────────────

describe('withDerivedIdempotency — the SLIDING window', () => {
	/**
	 * The exact failure a bucketed `floor(now / 60s)` would let through: a create just
	 * before a bucket boundary, retried just after it. With buckets alone the two land
	 * in DIFFERENT buckets and the retry duplicates — the precise thing the mechanism
	 * exists to prevent. Anchored on a real boundary so the arithmetic is not a guess.
	 */
	it('a retry STRADDLING a bucket boundary (t=59s → t=61s) still de-duplicates', async () => {
		const store = makeStore();
		const fn = vi.fn(
			async (): Promise<IdempotentResponse> => ({ status: 200, body: { id: 't1' } })
		);

		// A minute boundary: `floor(t / 60_000)` ticks over at :00.
		const boundary = new Date('2026-07-16T12:01:00.000Z').getTime();
		const before = new Date(boundary - 1_000); // t = 59s — bucket N-1
		const after = new Date(boundary + 1_000); // t = 61s — bucket N

		// Prove the premise: these two instants really are in different buckets, so this
		// test is exercising the boundary and not an accident of the fixture.
		expect(Math.floor(before.getTime() / MCP_IDEMPOTENCY_WINDOW_MS)).not.toBe(
			Math.floor(after.getTime() / MCP_IDEMPOTENCY_WINDOW_MS)
		);

		await callAt(store, before, LUNCH, fn);
		const retry = await callAt(store, after, LUNCH, fn);

		// ONE transaction, despite the boundary. The previous bucket is checked too.
		expect(fn).toHaveBeenCalledTimes(1);
		expect(retry.replayedAfterMs).toBe(2000);
	});

	it('de-duplicates at EVERY offset within the window, wherever the boundary falls', async () => {
		// A sweep, because the boundary case is not one instant: for a start offset every
		// second across a full window and a retry 1..60s later, the retry must ALWAYS
		// replay. Any bucketed implementation fails somewhere in this grid.
		for (let start = 0; start < 60; start++) {
			for (const gap of [1, 30, 59, 60]) {
				const store = makeStore();
				const fn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: {} }));

				await callAt(store, at(start), LUNCH, fn);
				const retry = await callAt(store, at(start + gap), LUNCH, fn);

				expect(fn, `start=${start}s gap=${gap}s must de-duplicate`).toHaveBeenCalledTimes(1);
				expect(retry.replayedAfterMs, `start=${start}s gap=${gap}s`).toBe(gap * 1000);
			}
		}
	});

	it('the window is 60s of ELAPSED time, NOT "the previous bucket" — no 120s wobble', async () => {
		// Two buckets alone would honour a row written at t=1s all the way to t=119s,
		// swallowing a legitimate repeat 118 seconds later. The elapsed-time check on
		// `createdAt` is what makes the window genuinely 60s wide in both directions.
		const store = makeStore();
		const fn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: {} }));

		// t=1s: inside bucket N.
		await callAt(store, at(1), LUNCH, fn);
		// t=90s: bucket N+1, so the prev-bucket row IS found — but it is 89s old.
		const later = await callAt(store, at(90), LUNCH, fn);

		expect(fn).toHaveBeenCalledTimes(2);
		expect(later.replayedAfterMs).toBeNull();
	});

	it('replays at exactly the window edge (60s) and creates one millisecond past it', async () => {
		const edge = makeStore();
		const edgeFn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: {} }));
		await callAt(edge, T0, LUNCH, edgeFn);
		expect((await callAt(edge, at(60), LUNCH, edgeFn)).replayedAfterMs).toBe(60_000);
		expect(edgeFn).toHaveBeenCalledTimes(1);

		const past = makeStore();
		const pastFn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: {} }));
		await callAt(past, T0, LUNCH, pastFn);
		const out = await callAt(past, new Date(T0.getTime() + 60_001), LUNCH, pastFn);
		expect(out.replayedAfterMs).toBeNull();
		expect(pastFn).toHaveBeenCalledTimes(2);
	});
});

describe('withDerivedIdempotency — concurrency and clock hazards', () => {
	it('a concurrent retry that loses the pending-first race raises in_progress', async () => {
		const store = makeStore();
		// The first call is still in flight: its row exists and is `pending`.
		const first = callAt(store, T0, LUNCH, () => new Promise(() => {}));
		void first;
		// Let the pending insert land before the second call reads.
		await new Promise((r) => setTimeout(r, 0));

		const err = await callAt(store, at(1), LUNCH).catch((e) => e);

		// NOT a duplicate create, and NOT an opaque throw: `mapToolError` turns this into
		// a `conflict` tool result the agent can read (ADR-0009).
		expect(err).toBeInstanceOf(IdempotencyConflictError);
		expect((err as IdempotencyConflictError).reason).toBe('in_progress');
	});

	it('a concurrent retry STRADDLING the boundary also raises in_progress, not a duplicate', async () => {
		// The previous-bucket row is `pending`: the original is still running. Creating now
		// would duplicate it, so this must conflict rather than fall through to a create.
		const store = makeStore();
		const boundary = new Date('2026-07-16T12:01:00.000Z').getTime();
		const fn = vi.fn();

		void callAt(store, new Date(boundary - 1_000), LUNCH, () => new Promise(() => {}));
		await new Promise((r) => setTimeout(r, 0));

		const err = await callAt(store, new Date(boundary + 1_000), LUNCH, fn).catch((e) => e);

		expect(err).toBeInstanceOf(IdempotencyConflictError);
		expect((err as IdempotencyConflictError).reason).toBe('in_progress');
		expect(fn).not.toHaveBeenCalled();
	});

	it('a PENDING previous-bucket row older than the window does not block a new create', async () => {
		// An orphaned pending row (a create that threw) must not wedge the tool forever:
		// past the window it is ignored like any other stale row.
		const store = makeStore();
		void callAt(store, at(1), LUNCH, () => new Promise(() => {}));
		await new Promise((r) => setTimeout(r, 0));

		const fn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: {} }));
		const out = await callAt(store, at(90), LUNCH, fn);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(out.replayedAfterMs).toBeNull();
	});

	it('files the pending row in the bucket it CHECKED, even if the clock crosses mid-call', async () => {
		// `now` is read ONCE. A `now()` re-read that drifted over the boundary could file
		// the row in a bucket this call never checked, leaving it invisible to the retry
		// it exists to catch.
		const store = makeStore();
		const boundary = new Date('2026-07-16T12:01:00.000Z').getTime();
		const start = new Date(boundary - 1);
		let calls = 0;
		// A clock that ticks 2ms per read — over the boundary between the two reads.
		const drifting = () => new Date(boundary - 1 + calls++ * 2);

		await withDerivedIdempotency({
			keyId: 'key_1',
			groupId: 'grp_1',
			toolName: 'create_transaction',
			args: LUNCH,
			store,
			fn: async () => ({ status: 200, body: { id: 't1' } }),
			now: drifting
		});

		// The row was filed under the bucket derived from the FIRST read.
		const expected = deriveIdempotencyKey({
			keyId: 'key_1',
			groupId: 'grp_1',
			toolName: 'create_transaction',
			args: LUNCH,
			bucket: Math.floor(start.getTime() / MCP_IDEMPOTENCY_WINDOW_MS)
		});
		expect(store.rows.has(`key_1::${expected}`)).toBe(true);
	});

	it('never reports a NEGATIVE age when a stored row is marginally in the future (clock skew)', async () => {
		const store = makeStore();
		const fn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: {} }));
		// Another app instance's clock is 2s ahead: it wrote the row "in the future".
		await callAt(store, at(2), LUNCH, fn);
		const out = await callAt(store, T0, LUNCH, fn);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(out.replayedAfterMs).toBe(0);
	});

	it('scopes the window to the CALLING key: another key’s identical create is its own', async () => {
		const store = makeStore();
		const fn = vi.fn(async (): Promise<IdempotentResponse> => ({ status: 200, body: {} }));

		await callAt(store, T0, LUNCH, fn);
		const other = await withDerivedIdempotency({
			keyId: 'key_2',
			groupId: 'grp_1',
			toolName: 'create_transaction',
			args: LUNCH,
			store,
			fn,
			now: () => at(1)
		});

		expect(fn).toHaveBeenCalledTimes(2);
		expect(other.replayedAfterMs).toBeNull();
	});
});
