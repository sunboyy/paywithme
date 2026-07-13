import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the §16.7 TIER-2 per-key, class-aware rate limiter.
//
// The PURE transition (`evaluateRateLimit`) is exercised directly and
// deterministically for BOTH window limits (read 100/60s, write 20/60s) — no DB.
// The ATOMIC writer (`consumeRateLimit`) + the guard (`requireRateLimit`) run
// against a small fluent `$lib/server/db` mock that records the upsert and returns
// a configurable post-write row, so the allow/deny derivation + the 429 envelope
// (code, `Retry-After` header, details) are asserted without a database.

// --- Fluent DB mock ---------------------------------------------------------
const { returnRow, capturedInsert, makeDb } = vi.hoisted(() => {
	// The row the NEXT `.returning()` resolves to (the atomic post-write state).
	const returnRow: { current: { count: number; lastRequest: number } } = {
		current: { count: 1, lastRequest: 0 }
	};
	// Captures the `.values(...)` payload of the last insert for assertions.
	const capturedInsert: { current: Record<string, unknown> | null } = { current: null };

	const db = {
		insert: () => ({
			values(values: Record<string, unknown>) {
				capturedInsert.current = values;
				return {
					onConflictDoUpdate: () => ({
						returning: () => Promise.resolve([returnRow.current])
					})
				};
			}
		})
	};
	return { returnRow, capturedInsert, makeDb: () => db };
});
vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	RATE_LIMITS,
	rateLimitKey,
	evaluateRateLimit,
	consumeRateLimit,
	requireRateLimit
} from './rate-limit';

beforeEach(() => {
	returnRow.current = { count: 1, lastRequest: 0 };
	capturedInsert.current = null;
});

describe('RATE_LIMITS constants (§16.7)', () => {
	it('pins read 100/60s and write 20/60s', () => {
		expect(RATE_LIMITS.read).toEqual({ max: 100, windowMs: 60_000 });
		expect(RATE_LIMITS.write).toEqual({ max: 20, windowMs: 60_000 });
	});
});

describe('rateLimitKey', () => {
	it('composes `${keyId}:${action}` so the two classes are disjoint rows', () => {
		expect(rateLimitKey('key_1', 'read')).toBe('key_1:read');
		expect(rateLimitKey('key_1', 'write')).toBe('key_1:write');
	});
});

describe('evaluateRateLimit — pure window-reset + conditional increment', () => {
	it('first-ever request (no row) starts a fresh window at count 1, allowed', () => {
		const d = evaluateRateLimit(null, 1_000, RATE_LIMITS.read);
		expect(d).toEqual({ allowed: true, count: 1, lastRequest: 1_000, retryAfterMs: 0 });
	});

	it('resets to count 1 once the window has fully rolled over (>= windowMs)', () => {
		const start = 1_000;
		// Exactly windowMs later → reset boundary is inclusive.
		const d = evaluateRateLimit(
			{ count: 100, lastRequest: start },
			start + 60_000,
			RATE_LIMITS.read
		);
		expect(d).toEqual({ allowed: true, count: 1, lastRequest: start + 60_000, retryAfterMs: 0 });
	});

	describe('read limit (100/60s)', () => {
		it('allows the 100th request in the window (count 99 → 100)', () => {
			const d = evaluateRateLimit({ count: 99, lastRequest: 1_000 }, 2_000, RATE_LIMITS.read);
			expect(d.allowed).toBe(true);
			expect(d.count).toBe(100);
			expect(d.retryAfterMs).toBe(0);
		});

		it('denies the 101st request and reports the remaining window', () => {
			// 10s into the window, already at the cap → denied, ~50s left.
			const d = evaluateRateLimit({ count: 100, lastRequest: 1_000 }, 11_000, RATE_LIMITS.read);
			expect(d.allowed).toBe(false);
			expect(d.count).toBe(101);
			expect(d.lastRequest).toBe(1_000); // window start unchanged on denial
			expect(d.retryAfterMs).toBe(60_000 - 10_000);
		});
	});

	describe('write limit (20/60s) — independent counter', () => {
		it('allows the 20th write (count 19 → 20)', () => {
			const d = evaluateRateLimit({ count: 19, lastRequest: 1_000 }, 2_000, RATE_LIMITS.write);
			expect(d.allowed).toBe(true);
			expect(d.count).toBe(20);
		});

		it('denies the 21st write — a much tighter cap than reads', () => {
			const d = evaluateRateLimit({ count: 20, lastRequest: 1_000 }, 5_000, RATE_LIMITS.write);
			expect(d.allowed).toBe(false);
			expect(d.retryAfterMs).toBe(60_000 - 4_000);
		});
	});
});

describe('consumeRateLimit — atomic upsert + decision derivation', () => {
	it('inserts the seed row keyed `${keyId}:${action}` with count 1', async () => {
		returnRow.current = { count: 1, lastRequest: 5_000 };
		await consumeRateLimit('key_1', 'read', 5_000);
		expect(capturedInsert.current).toMatchObject({
			key: 'key_1:read',
			count: 1,
			lastRequest: 5_000
		});
		expect(typeof capturedInsert.current?.id).toBe('string');
	});

	it('allows when the atomic post-write count is within the cap', async () => {
		returnRow.current = { count: 100, lastRequest: 1_000 };
		const d = await consumeRateLimit('key_1', 'read', 2_000);
		expect(d.allowed).toBe(true);
		expect(d.retryAfterMs).toBe(0);
	});

	it('denies when the atomic post-write count exceeds the cap, with the remaining window', async () => {
		returnRow.current = { count: 101, lastRequest: 1_000 };
		const d = await consumeRateLimit('key_1', 'read', 11_000);
		expect(d.allowed).toBe(false);
		expect(d.count).toBe(101);
		expect(d.retryAfterMs).toBe(60_000 - 10_000);
	});

	it('enforces the write cap independently (21 > 20 → deny)', async () => {
		returnRow.current = { count: 21, lastRequest: 1_000 };
		const d = await consumeRateLimit('key_1', 'write', 2_000);
		expect(d.allowed).toBe(false);
		expect(d.count).toBe(21);
	});
});

describe('requireRateLimit — the shared guard', () => {
	it('returns null (proceed) when the counter is within the cap', async () => {
		returnRow.current = { count: 5, lastRequest: Date.now() };
		const res = await requireRateLimit({ keyId: 'key_1' }, 'read');
		expect(res).toBeNull();
	});

	it('returns the 429 rate_limited envelope + Retry-After when the read cap is exceeded', async () => {
		const now = Date.now();
		// 10s into the window, over the cap → ~50s remaining.
		returnRow.current = { count: 101, lastRequest: now - 10_000 };
		const res = (await requireRateLimit({ keyId: 'key_1' }, 'read')) as Response;

		expect(res).not.toBeNull();
		expect(res.status).toBe(429);

		const retryHeader = res.headers.get('Retry-After');
		expect(retryHeader).not.toBeNull();
		const retryAfterSeconds = Number(retryHeader);
		// ~50s left; allow a 1s slop for the wall-clock read inside the guard.
		expect(retryAfterSeconds).toBeGreaterThanOrEqual(50);
		expect(retryAfterSeconds).toBeLessThanOrEqual(51);

		const body = await res.json();
		expect(body.error.code).toBe('rate_limited');
		expect(body.error.details).toMatchObject({
			scope: 'read',
			limit: 100,
			windowSeconds: 60,
			retryAfterSeconds
		});
	});

	it('reports the write scope + cap of 20 on a write denial', async () => {
		const now = Date.now();
		returnRow.current = { count: 21, lastRequest: now };
		const res = (await requireRateLimit({ keyId: 'key_w' }, 'write')) as Response;
		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body.error.details.scope).toBe('write');
		expect(body.error.details.limit).toBe(20);
		expect(body.error.details.windowSeconds).toBe(60);
		// windowMs and (now - lastRequest≈0) → ~60s, header mirrors the body field.
		expect(Number(res.headers.get('Retry-After'))).toBe(body.error.details.retryAfterSeconds);
	});
});
