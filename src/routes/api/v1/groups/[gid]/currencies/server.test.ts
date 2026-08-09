// Unit test for GET /api/v1/groups/{gid}/currencies (issue #68; PLAN §16.4,
// §16.5, §7.5.2 "REST surface"; ADR-0014 decision 8).
//
// HTTP-boundary test with a real principal and the REAL mapper; only
// `listCurrenciesForGroup` is overridden (via `importOriginal`, so the real
// `GroupAccessError` mapping stays intact). What it pins:
//   - the group's set is served by DISPLAY code, in the service's order, and the
//     opaque row key never appears;
//   - membership is enforced by the service and `GroupAccessError` becomes the
//     CONFLATED 404 — a group the key can't see is indistinguishable from an absent
//     one, exactly like every other `/groups/{gid}/…` read (§16.2 / §16.5);
//   - the tier-2 read limiter is consumed and short-circuits (§16.7).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupAccessError } from '$lib/server/groups';

const { listCurrenciesForGroup } = vi.hoisted(() => ({ listCurrenciesForGroup: vi.fn() }));
vi.mock('$lib/server/currencies', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/currencies')>();
	return { ...actual, listCurrenciesForGroup };
});

const { requireRateLimit } = vi.hoisted(() => ({ requireRateLimit: vi.fn() }));
vi.mock('$lib/server/api/rate-limit', () => ({ requireRateLimit }));

import { GET } from './+server';
import { rateLimited } from '$lib/server/api/errors';
import type { GroupCurrency } from '$lib/server/currencies';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	name: 'agent key',
	userId: 'user_1',
	permissions: { api: ['read'] }
};

/** A seeded row, as `listCurrenciesForGroup` returns it. */
const thb: GroupCurrency = {
	code: 'THB',
	displayCode: 'THB',
	name: 'Thai Baht',
	exponent: 2,
	symbol: '฿',
	groupId: null,
	createdBy: null,
	createdAt: null,
	isCustom: false
};

/** This group's own row — opaque key, member-chosen display code. */
const beer: GroupCurrency = {
	code: 'cur_9f2e5a10-0000-4000-8000-000000000001',
	displayCode: 'BEER',
	name: 'Bottle of beer',
	exponent: 0,
	symbol: '🍺',
	groupId: 'g1',
	createdBy: 'user_1',
	createdAt: new Date('2026-08-01T00:00:00.000Z'),
	isCustom: true
};

function makeEvent(gid = 'g1', apiKey: ApiKeyPrincipal | null = principal) {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/currencies`);
	return {
		locals: { apiKey },
		url,
		request: new Request(url),
		params: { gid }
	} as unknown as Parameters<typeof GET>[0];
}

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

beforeEach(() => {
	vi.clearAllMocks();
	requireRateLimit.mockResolvedValue(null);
});

describe('GET /api/v1/groups/{gid}/currencies', () => {
	it("serves the seeded rows PLUS the group's own, by display code", async () => {
		listCurrenciesForGroup.mockResolvedValue([thb, beer]);

		const { status, body } = await read((await GET(makeEvent())) as Response);
		expect(status).toBe(200);
		// The service is asked for THIS key's user and THIS group — the access check
		// (and therefore the 404 conflation) lives there (§12).
		expect(listCurrenciesForGroup).toHaveBeenCalledWith({ userId: 'user_1', groupId: 'g1' });
		// Order is the service's (seeded block first) and is served as-is.
		expect(body).toEqual([
			{ code: 'THB', exponent: 2, symbol: '฿' },
			{ code: 'BEER', exponent: 0, symbol: '🍺' }
		]);
		expect(requireRateLimit).toHaveBeenCalledWith(principal, 'read');
	});

	it('never puts the opaque row key on the wire', async () => {
		// The whole reason this endpoint exists is to publish the display code WITHOUT
		// publishing the internal identifier (ADR-0014 decision 8, "why not expose the
		// opaque code"). If the mapper ever reached for `code`, this fails.
		listCurrenciesForGroup.mockResolvedValue([beer]);
		const { body } = await read((await GET(makeEvent())) as Response);
		expect(JSON.stringify(body)).not.toContain('cur_');
	});

	it('drops the internal `name` / `isCustom` fields (the owned-DTO seam)', async () => {
		listCurrenciesForGroup.mockResolvedValue([thb, beer]);
		const { body } = await read((await GET(makeEvent())) as Response);
		for (const row of body) {
			expect(Object.keys(row).sort()).toEqual(['code', 'exponent', 'symbol']);
		}
	});

	it('no access (GroupAccessError) → 404 not_found, conflated with absent', async () => {
		listCurrenciesForGroup.mockRejectedValue(new GroupAccessError());
		const { status, body } = await read((await GET(makeEvent('someone-elses-group'))) as Response);
		expect(status).toBe(404);
		expect(body).toEqual({
			error: { code: 'not_found', message: 'The requested resource was not found.' }
		});
	});

	it('no principal → 401 (defensive; the hook normally guarantees one)', async () => {
		const { status, body } = await read((await GET(makeEvent('g1', null))) as Response);
		expect(status).toBe(401);
		expect(body.error.code).toBe('unauthorized');
		expect(listCurrenciesForGroup).not.toHaveBeenCalled();
	});

	it('429 rate_limited (tier-2 read) short-circuits before the service runs', async () => {
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
		expect(listCurrenciesForGroup).not.toHaveBeenCalled();
	});
});
