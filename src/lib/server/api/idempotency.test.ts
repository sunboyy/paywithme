import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the `/api/v1` write idempotency semantics + store (PLAN §16.6).
//
// The SEMANTICS (`withIdempotency`) are exercised with an INJECTED store stub — no
// DB — so the three outcomes (replay / 409 key_reused / 409 in_progress) are tested
// directly. The production store + TTL cleanup are exercised against a small fluent
// `$lib/server/db` mock that records the insert/select/update/delete calls.

// --- Fluent DB mock (for the store + cleanup) -----------------------------
const { inserts, deletes, selectRows, insertThrow, makeDb } = vi.hoisted(() => {
	const inserts: Record<string, unknown>[] = [];
	const deletes: { pred: unknown }[] = [];
	// The rows the NEXT select resolves to (the store's `load`).
	const selectRows: { current: unknown[] } = { current: [] };
	// When set, the NEXT insert `.values()` throws this (e.g. a `23505`).
	const insertThrow: { error: unknown } = { error: undefined };

	function selectChain() {
		const chain: Record<string, unknown> = {};
		for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => resolve(selectRows.current);
		return chain;
	}

	const db = {
		insert: () => ({
			values(values: Record<string, unknown>) {
				inserts.push(values);
				if (insertThrow.error !== undefined) {
					const err = insertThrow.error;
					insertThrow.error = undefined;
					throw err;
				}
				return Promise.resolve(undefined);
			}
		}),
		select: () => selectChain(),
		update: () => {
			const chain: Record<string, unknown> = {};
			chain.set = () => chain;
			chain.where = () => Promise.resolve(undefined);
			return chain;
		},
		delete: () => ({
			where: (pred: unknown) => {
				deletes.push({ pred });
				return Promise.resolve(undefined);
			}
		})
	};

	return { inserts, deletes, selectRows, insertThrow, makeDb: () => db };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	withIdempotency,
	fingerprintRequestBody,
	createDbIdempotencyStore,
	cleanupExpiredIdempotencyKeys,
	IdempotencyConflictError,
	IDEMPOTENCY_TTL_MS,
	type IdempotencyStore,
	type IdempotencyRecord,
	type IdempotentResponse
} from './idempotency';

beforeEach(() => {
	inserts.length = 0;
	deletes.length = 0;
	selectRows.current = [];
	insertThrow.error = undefined;
});

/** A configurable store stub: control the insert winner + the loaded row. */
function makeStore({
	won,
	existing = null
}: {
	won: boolean;
	existing?: IdempotencyRecord | null;
}): IdempotencyStore & {
	inserted: unknown[];
	completed: { keyId: string; key: string; response: IdempotentResponse }[];
} {
	const inserted: unknown[] = [];
	const completed: { keyId: string; key: string; response: IdempotentResponse }[] = [];
	return {
		inserted,
		completed,
		async insertPending(row) {
			inserted.push(row);
			return won;
		},
		async load() {
			return existing;
		},
		async markCompleted(keyId, key, response) {
			completed.push({ keyId, key, response });
		}
	};
}

describe('fingerprintRequestBody', () => {
	it('is deterministic for the same bytes and differs for different bodies', () => {
		const a = fingerprintRequestBody('{"amount":100}');
		const b = fingerprintRequestBody('{"amount":100}');
		const c = fingerprintRequestBody('{"amount":200}');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		// SHA-256 hex.
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('withIdempotency — winner runs the create ONCE', () => {
	it('inserts pending, runs fn, stores the response, and returns it', async () => {
		const store = makeStore({ won: true });
		const fn = vi.fn(
			async (): Promise<IdempotentResponse> => ({ status: 201, body: { id: 't1' } })
		);
		const now = new Date('2026-07-12T00:00:00.000Z');

		const res = await withIdempotency({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			rawBody: '{"amount":100}',
			store,
			fn,
			now: () => now
		});

		expect(res).toEqual({ status: 201, body: { id: 't1' } });
		expect(fn).toHaveBeenCalledTimes(1);
		// The pending row carries the 24h TTL boundary and the body fingerprint.
		expect(store.inserted).toHaveLength(1);
		const row = store.inserted[0] as { requestHash: string; expiresAt: Date };
		expect(row.requestHash).toBe(fingerprintRequestBody('{"amount":100}'));
		expect(row.expiresAt.getTime()).toBe(now.getTime() + IDEMPOTENCY_TTL_MS);
		// The produced response is stored for later replay.
		expect(store.completed).toEqual([
			{ keyId: 'key_1', key: 'abc', response: { status: 201, body: { id: 't1' } } }
		]);
	});
});

describe('withIdempotency — loser (row already exists)', () => {
	it('REPLAYS a completed row with a matching body — fn never runs', async () => {
		const hash = fingerprintRequestBody('{"amount":100}');
		const store = makeStore({
			won: false,
			existing: {
				requestHash: hash,
				status: 'completed',
				responseStatus: 201,
				responseBody: { id: 't1' }
			}
		});
		const fn = vi.fn(
			async (): Promise<IdempotentResponse> => ({ status: 201, body: { id: 'DUP' } })
		);

		const res = await withIdempotency({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			rawBody: '{"amount":100}',
			store,
			fn
		});

		expect(res).toEqual({ status: 201, body: { id: 't1' } });
		expect(fn).not.toHaveBeenCalled();
		expect(store.completed).toHaveLength(0);
	});

	it('409 key_reused when the same key was used with a DIFFERENT body', async () => {
		const store = makeStore({
			won: false,
			existing: {
				requestHash: fingerprintRequestBody('{"amount":100}'),
				status: 'completed',
				responseStatus: 201,
				responseBody: { id: 't1' }
			}
		});
		const fn = vi.fn();

		const err = await withIdempotency({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			rawBody: '{"amount":999}', // different body → different hash
			store,
			fn
		}).catch((e) => e);

		expect(err).toBeInstanceOf(IdempotencyConflictError);
		expect((err as IdempotencyConflictError).reason).toBe('key_reused');
		expect(fn).not.toHaveBeenCalled();
	});

	it('409 in_progress when the row is still pending (same body, concurrent retry)', async () => {
		const hash = fingerprintRequestBody('{"amount":100}');
		const store = makeStore({
			won: false,
			existing: { requestHash: hash, status: 'pending', responseStatus: null, responseBody: null }
		});

		const err = await withIdempotency({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			rawBody: '{"amount":100}',
			store,
			fn: vi.fn()
		}).catch((e) => e);

		expect(err).toBeInstanceOf(IdempotencyConflictError);
		expect((err as IdempotencyConflictError).reason).toBe('in_progress');
	});

	it('409 in_progress when the row vanished between the failed insert and the read', async () => {
		const store = makeStore({ won: false, existing: null });
		const err = await withIdempotency({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			rawBody: '{}',
			store,
			fn: vi.fn()
		}).catch((e) => e);
		expect(err).toBeInstanceOf(IdempotencyConflictError);
		expect((err as IdempotencyConflictError).reason).toBe('in_progress');
	});
});

describe('createDbIdempotencyStore — pending-first insert race', () => {
	it('returns true when the insert wins', async () => {
		const store = createDbIdempotencyStore();
		const won = await store.insertPending({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			requestHash: 'h',
			createdAt: new Date(),
			expiresAt: new Date()
		});
		expect(won).toBe(true);
		expect(inserts[0]).toMatchObject({ keyId: 'key_1', idempotencyKey: 'abc', status: 'pending' });
	});

	it('returns false on a unique violation (23505) — the loser', async () => {
		insertThrow.error = { code: '23505' };
		const store = createDbIdempotencyStore();
		const won = await store.insertPending({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			requestHash: 'h',
			createdAt: new Date(),
			expiresAt: new Date()
		});
		expect(won).toBe(false);
	});

	it('returns false on a WRAPPED unique violation — the shape Drizzle actually throws', async () => {
		// Drizzle raises a `DrizzleQueryError` whose own `code` is undefined and whose
		// `cause` is the `pg` error carrying `23505`. Checking only the top-level object
		// let the duplicate insert escape as a 500 instead of replaying the stored
		// response (§16.6) — the real-DB boundary suite caught it, so pin the shape here.
		const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });
		insertThrow.error = Object.assign(new Error('Failed query: insert into "idempotency_key"'), {
			cause: pgError
		});
		const store = createDbIdempotencyStore();
		const won = await store.insertPending({
			keyId: 'key_1',
			idempotencyKey: 'abc',
			requestHash: 'h',
			createdAt: new Date(),
			expiresAt: new Date()
		});
		expect(won).toBe(false);
	});

	it('re-throws a non-unique error', async () => {
		insertThrow.error = { code: '08006' }; // connection failure, not a dedup
		const store = createDbIdempotencyStore();
		await expect(
			store.insertPending({
				keyId: 'key_1',
				idempotencyKey: 'abc',
				requestHash: 'h',
				createdAt: new Date(),
				expiresAt: new Date()
			})
		).rejects.toEqual({ code: '08006' });
	});

	it('re-throws a WRAPPED non-unique error (the cause walk does not swallow real failures)', async () => {
		const pgError = Object.assign(new Error('connection terminated'), { code: '08006' });
		const wrapped = Object.assign(new Error('Failed query'), { cause: pgError });
		insertThrow.error = wrapped;
		const store = createDbIdempotencyStore();
		await expect(
			store.insertPending({
				keyId: 'key_1',
				idempotencyKey: 'abc',
				requestHash: 'h',
				createdAt: new Date(),
				expiresAt: new Date()
			})
		).rejects.toBe(wrapped);
	});

	it('load returns the mapped row or null', async () => {
		const store = createDbIdempotencyStore();
		selectRows.current = [
			{ requestHash: 'h', status: 'completed', responseStatus: 201, responseBody: { id: 't1' } }
		];
		expect(await store.load('key_1', 'abc')).toEqual({
			requestHash: 'h',
			status: 'completed',
			responseStatus: 201,
			responseBody: { id: 't1' }
		});
		selectRows.current = [];
		expect(await store.load('key_1', 'abc')).toBeNull();
	});
});

describe('cleanupExpiredIdempotencyKeys — 24h TTL sweep', () => {
	it('issues a delete (past-expiry rows) — keeps the store bounded', async () => {
		await cleanupExpiredIdempotencyKeys(new Date('2026-07-12T00:00:00.000Z'));
		expect(deletes).toHaveLength(1);
		expect(deletes[0].pred).toBeDefined();
	});
});
