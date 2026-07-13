// Unit test for GET /api/v1/groups/{gid} (PLAN §16.4, §16.5).
//
// HTTP-boundary test with a REAL principal + the REAL `toGroupDto` mapper; only
// `getGroupForUser` is mocked. Asserts: happy path → 200 DTO (no `deletedAt`);
// `null` from the read (absent OR no-access) → the CONFLATED 404 `not_found`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getGroupForUser } = vi.hoisted(() => ({ getGroupForUser: vi.fn() }));
vi.mock('$lib/server/groups', () => ({ getGroupForUser }));

// §16.7 tier-2 read limiter: stubbed to allow (logic covered in api/rate-limit.test.ts).
const { requireRateLimit } = vi.hoisted(() => ({ requireRateLimit: vi.fn() }));
vi.mock('$lib/server/api/rate-limit', () => ({ requireRateLimit }));

import { GET } from './+server';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	name: 'agent key',
	userId: 'user_1',
	permissions: { api: ['read'] }
};

function makeEvent(gid = 'g1', apiKey: ApiKeyPrincipal | null = principal) {
	const url = new URL(`http://localhost/api/v1/groups/${gid}`);
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

describe('GET /api/v1/groups/{gid}', () => {
	it('200 with the DTO; forwards (userId, gid)', async () => {
		getGroupForUser.mockResolvedValue(group);
		const { status, body } = await read((await GET(makeEvent('g1'))) as Response);
		expect(status).toBe(200);
		expect(getGroupForUser).toHaveBeenCalledWith('user_1', 'g1');
		expect(body).toEqual({
			id: 'g1',
			name: 'Trip',
			settlementCurrency: 'THB',
			createdBy: 'user_1',
			createdAt: '2026-01-02T03:04:05.000Z'
		});
		expect(body).not.toHaveProperty('deletedAt');
	});

	it('null (absent OR no-access) → 404 not_found (conflated)', async () => {
		getGroupForUser.mockResolvedValue(null);
		const { status, body } = await read((await GET(makeEvent('nope'))) as Response);
		expect(status).toBe(404);
		expect(body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
	});
});
