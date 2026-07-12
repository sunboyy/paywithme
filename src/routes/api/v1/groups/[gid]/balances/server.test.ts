// Unit test for GET /api/v1/groups/{gid}/balances (PLAN §16.4, §16.5, §8.1).
//
// HTTP-boundary test with a REAL principal + the REAL `toBalanceDto` mapper; both
// `getGroupForUser` (settlement-currency source + access gate) and `getGroupBalances`
// are mocked. Asserts: happy path → 200 with each balance nested as self-describing
// `{ amount, currency }` money in the group's settlement currency; an inaccessible
// group (`getGroupForUser` → null) → the CONFLATED 404 (and balances is NOT queried).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getGroupForUser } = vi.hoisted(() => ({ getGroupForUser: vi.fn() }));
const { getGroupBalances } = vi.hoisted(() => ({ getGroupBalances: vi.fn() }));
vi.mock('$lib/server/groups', () => ({ getGroupForUser }));
vi.mock('$lib/server/balances', () => ({ getGroupBalances }));

// §16.7 tier-2 read limiter: stubbed to allow (logic covered in api/rate-limit.test.ts).
const { requireRateLimit } = vi.hoisted(() => ({ requireRateLimit: vi.fn() }));
vi.mock('$lib/server/api/rate-limit', () => ({ requireRateLimit }));

import { GET } from './+server';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	userId: 'user_1',
	permissions: { api: ['read'] }
};

function makeEvent(gid = 'g1') {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/balances`);
	return {
		locals: { apiKey: principal },
		url,
		request: new Request(url),
		params: { gid }
	} as unknown as Parameters<typeof GET>[0];
}

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

const group = {
	id: 'g1',
	name: 'Trip',
	settlementCurrency: 'THB',
	createdBy: 'user_1',
	createdAt: new Date('2026-01-02T03:04:05.000Z'),
	deletedAt: null
};

beforeEach(() => {
	vi.clearAllMocks();
	requireRateLimit.mockResolvedValue(null);
});

describe('GET /api/v1/groups/{gid}/balances', () => {
	it('200 with balances nested as settlement-currency money', async () => {
		getGroupForUser.mockResolvedValue(group);
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 5000 },
			{ memberId: 'm2', balance: -5000 }
		]);
		const { status, body } = await read((await GET(makeEvent('g1'))) as Response);
		expect(status).toBe(200);
		expect(getGroupBalances).toHaveBeenCalledWith({ userId: 'user_1', groupId: 'g1' });
		expect(body).toEqual([
			{ memberId: 'm1', balance: { amount: 5000, currency: 'THB' } },
			{ memberId: 'm2', balance: { amount: -5000, currency: 'THB' } }
		]);
	});

	it('inaccessible group → 404 not_found; balances never queried', async () => {
		getGroupForUser.mockResolvedValue(null);
		const { status, body } = await read((await GET(makeEvent('secret'))) as Response);
		expect(status).toBe(404);
		expect(body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
		expect(getGroupBalances).not.toHaveBeenCalled();
	});
});
