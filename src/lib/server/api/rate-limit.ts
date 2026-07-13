// TIER-2 (primary, class-aware) `/api/v1` rate limiter (PLAN §16.7).
//
// The IP+path limiter in `auth.ts` does NOT run for `/api/v1` (the guard calls
// `verifyApiKey` server-side, bypassing `auth.handler`) and can't be keyed
// per-key. §16.7 fixes this with two PER-KEY tiers:
//   - Tier 1 (backstop): the plugin's own built-in per-key counter, a generous
//     combined 150/60s set at key creation (`auth.ts`). One bucket per key.
//   - Tier 2 (THIS module, primary): two INDEPENDENT counters per key — `read`
//     100/60s and `write` 20/60s — enforced in the route layer AFTER `verifyApiKey`
//     (the hook) and AFTER the 403 scope check. A request increments exactly ONE
//     counter, chosen by the ENDPOINT's §16.2 read/write class (NOT the key's own
//     scope): a read endpoint consumes `read`, a write endpoint consumes `write`.
//
// Backed by `api_key_class_rate_limit` (mirrors `rate_limit`'s shape), keyed
// `` `${apiKeyId}:${class}` ``. The decision is split into a PURE transition
// (`evaluateRateLimit`, deterministic in `now` → unit-tested for both window
// limits without a DB) and the ATOMIC writer (`consumeRateLimit`, one
// `INSERT … ON CONFLICT DO UPDATE … RETURNING` so concurrent verifications can
// never exceed the cap). Same split better-auth uses for its own limiter.

import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { apiKeyClassRateLimit } from '$lib/server/db/api-key-class-rate-limit-schema';
import type { ApiKeyPrincipal } from './principal';
import { rateLimited } from './errors';

/** The §16.2 request/endpoint class each counter is keyed by. */
export type RateLimitAction = 'read' | 'write';

/** A single counter's cap + window. */
export interface RateLimitConfig {
	/** Max requests allowed within `windowMs`. */
	max: number;
	/** Window length in milliseconds (60s per the `auth.ts` convention). */
	windowMs: number;
}

/**
 * The two independent per-key limits (PLAN §16.7): read 100/60s, write 20/60s.
 * 60s windows match the `auth.ts` IP+path limiter convention.
 */
export const RATE_LIMITS: Record<RateLimitAction, RateLimitConfig> = {
	read: { max: 100, windowMs: 60_000 },
	write: { max: 20, windowMs: 60_000 }
};

/** The result of a limiter transition: the post-write state + whether allowed. */
export interface RateLimitDecision {
	/** True when THIS request is within the cap (so the handler may proceed). */
	allowed: boolean;
	/** The post-write counter value for the current window. */
	count: number;
	/** The post-write window-start ms-epoch. */
	lastRequest: number;
	/** Milliseconds until the window frees up. `0` when allowed. */
	retryAfterMs: number;
}

/** Build the `api_key_class_rate_limit.key` lookup value: `` `${keyId}:${action}` ``. */
export function rateLimitKey(keyId: string, action: RateLimitAction): string {
	return `${keyId}:${action}`;
}

/**
 * PURE window-reset + conditional-increment transition (PLAN §16.7).
 *
 * Given the CURRENT stored row (or `null`/`undefined` for a first-ever request),
 * `now`, and the counter's `limit`, compute the NEXT stored state and whether THIS
 * request is allowed:
 *   - first request OR the window has fully rolled over (`now - lastRequest >=
 *     windowMs`) → reset to a fresh window of count 1, always allowed;
 *   - otherwise advance the counter by one — allowed iff the advanced count is
 *     still within `max` (so the max-th request passes and the max+1-th is denied).
 *     On a denial `lastRequest` is unchanged, so the retry window counts down from
 *     the window's FIRST request; `retryAfterMs = windowMs - (now - lastRequest)`.
 *
 * Deterministic in `now`, so both window limits (read 100, write 20) are
 * unit-tested directly. `consumeRateLimit`'s SQL encodes the exact same transition.
 */
export function evaluateRateLimit(
	current: { count: number; lastRequest: number } | null | undefined,
	now: number,
	limit: RateLimitConfig
): RateLimitDecision {
	if (!current || now - current.lastRequest >= limit.windowMs) {
		return { allowed: true, count: 1, lastRequest: now, retryAfterMs: 0 };
	}
	const count = current.count + 1;
	const allowed = count <= limit.max;
	const retryAfterMs = allowed ? 0 : limit.windowMs - (now - current.lastRequest);
	return { allowed, count, lastRequest: current.lastRequest, retryAfterMs };
}

/**
 * ATOMICALLY consume one unit of the `(keyId, action)` counter and return the
 * decision (PLAN §16.7).
 *
 * The window-reset + increment happens in a SINGLE `INSERT … ON CONFLICT DO UPDATE
 * … RETURNING` statement (a `CASE`-based `count`/`lastRequest` set), so two
 * concurrent verifications of the same key race on ONE row and can never both slip
 * past the cap — atomicity = one SQL statement, no read-then-write gap. The
 * decision is derived from the atomic post-write row: `allowed` iff the counter is
 * still within the cap (mirrors {@link evaluateRateLimit}).
 */
export async function consumeRateLimit(
	keyId: string,
	action: RateLimitAction,
	now: number = Date.now()
): Promise<RateLimitDecision> {
	const limit = RATE_LIMITS[action];
	const key = rateLimitKey(keyId, action);

	// True when the stored window has fully rolled over → reset to a fresh window.
	const windowRolledOver = sql`${now} - ${apiKeyClassRateLimit.lastRequest} >= ${limit.windowMs}`;

	const rows = await db
		.insert(apiKeyClassRateLimit)
		.values({ id: crypto.randomUUID(), key, count: 1, lastRequest: now })
		.onConflictDoUpdate({
			target: apiKeyClassRateLimit.key,
			set: {
				// Reset to 1 on a rolled-over window, else increment. On sustained denial
				// the counter climbs past `max` (harmless — bounded by the window, and the
				// decision only checks `count <= max`).
				count: sql`case when ${windowRolledOver} then 1 else ${apiKeyClassRateLimit.count} + 1 end`,
				// Advance the window start only on a reset; a same-window request (allowed
				// or denied) keeps the original start so the retry countdown is stable.
				lastRequest: sql`case when ${windowRolledOver} then ${now} else ${apiKeyClassRateLimit.lastRequest} end`
			}
		})
		.returning({
			count: apiKeyClassRateLimit.count,
			lastRequest: apiKeyClassRateLimit.lastRequest
		});

	const row = rows[0];
	const allowed = row.count <= limit.max;
	const retryAfterMs = allowed ? 0 : limit.windowMs - (now - row.lastRequest);
	return { allowed, count: row.count, lastRequest: row.lastRequest, retryAfterMs };
}

/**
 * The shared tier-2 guard (PLAN §16.7). Every `/api/v1` handler calls this AFTER
 * `verifyApiKey` (the hook) and — for writes — AFTER the 403 scope check, so a read
 * key hitting a write endpoint still gets 403 (not 429) and never consumes the
 * write counter:
 *
 *     const limited = await requireRateLimit(principal, 'read'); // or 'write'
 *     if (limited) return limited;   // 429 rate_limited + Retry-After
 *
 * Returns the 429 `rate_limited` envelope `Response` (with a `Retry-After` header
 * and `details: { scope, limit, windowSeconds, retryAfterSeconds }`) when the
 * counter is exhausted, or `null` when the request may proceed. `retryAfterSeconds`
 * and the header are `Math.ceil(retryAfterMs / 1000)`.
 */
export async function requireRateLimit(
	principal: Pick<ApiKeyPrincipal, 'keyId'>,
	action: RateLimitAction
): Promise<Response | null> {
	const decision = await consumeRateLimit(principal.keyId, action);
	if (decision.allowed) return null;

	const limit = RATE_LIMITS[action];
	const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
	return rateLimited(
		'Rate limit exceeded.',
		{
			scope: action,
			limit: limit.max,
			windowSeconds: limit.windowMs / 1000,
			retryAfterSeconds
		},
		retryAfterSeconds
	);
}
