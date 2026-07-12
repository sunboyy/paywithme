// Unit test for GET /api/v1/currencies (PLAN §16.4, §7.5.1).
//
// Serves the canonical `$lib/money` `CURRENCIES` table projected to the documented
// `{ code, exponent, symbol }` DTO. We assert the 200 status, that every canonical
// currency is present with the right triple, and that the internal `name` field is
// DROPPED (the owned-DTO seam keeping UI-only fields off the wire).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The §16.7 tier-2 read limiter is exercised in `api/rate-limit.test.ts`; here we
// stub it (allow by default) so the DTO assertions stay DB-free, and flip it to a
// 429 in one test to prove the route short-circuits.
const { requireRateLimit } = vi.hoisted(() => ({ requireRateLimit: vi.fn() }));
vi.mock('$lib/server/api/rate-limit', () => ({ requireRateLimit }));

import { GET } from './+server';
import { CURRENCIES } from '$lib/money';
import { rateLimited } from '$lib/server/api/errors';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	userId: 'user_1',
	permissions: { api: ['read'] }
};

/** Minimal RequestEvent — the handler reads only `locals.apiKey`. */
function makeEvent(apiKey: ApiKeyPrincipal | null = principal) {
	const url = new URL('http://localhost/api/v1/currencies');
	return {
		locals: { apiKey },
		url,
		request: new Request(url),
		params: {}
	} as unknown as Parameters<typeof GET>[0];
}

async function read(res: Response) {
	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		body: await res.json()
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	requireRateLimit.mockResolvedValue(null);
});

describe('GET /api/v1/currencies', () => {
	it('returns 200 with every currency as { code, exponent, symbol }', async () => {
		const { status, contentType, body } = await read((await GET(makeEvent())) as Response);
		expect(status).toBe(200);
		expect(contentType).toContain('application/json');
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(CURRENCIES.length);
		// First row matches the canonical data exactly (order preserved).
		expect(body[0]).toEqual({
			code: CURRENCIES[0].code,
			exponent: CURRENCIES[0].exponent,
			symbol: CURRENCIES[0].symbol
		});
		// Tier-2 read counter consumed for this key (§16.7).
		expect(requireRateLimit).toHaveBeenCalledWith(principal, 'read');
	});

	it('drops the internal UI-only `name` field', async () => {
		const { body } = await read((await GET(makeEvent())) as Response);
		for (const row of body) {
			expect(row).not.toHaveProperty('name');
			expect(Object.keys(row).sort()).toEqual(['code', 'exponent', 'symbol']);
		}
	});

	it('429 rate_limited (tier-2 read) short-circuits before serving the reference table', async () => {
		requireRateLimit.mockResolvedValueOnce(
			rateLimited(
				'Rate limit exceeded.',
				{ scope: 'read', limit: 100, windowSeconds: 60, retryAfterSeconds: 37 },
				37
			)
		);
		const res = (await GET(makeEvent())) as Response;
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('37');
		const body = await res.json();
		expect(body.error.code).toBe('rate_limited');
		expect(body.error.details).toEqual({
			scope: 'read',
			limit: 100,
			windowSeconds: 60,
			retryAfterSeconds: 37
		});
	});
});
