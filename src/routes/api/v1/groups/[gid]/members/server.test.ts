// Unit test for GET /api/v1/groups/{gid}/members (PLAN §16.4, §16.5).
//
// HTTP-boundary test with a REAL principal + the REAL `toMemberDto` mapper; only
// `listMembers` is mocked. Asserts: happy path → 200 DTO rows; a thrown
// `GroupAccessError` (no access) → the CONFLATED 404 `not_found`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupAccessError } from '$lib/server/groups';

const { listMembers } = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock('$lib/server/members', () => ({ listMembers }));

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

function makeEvent(gid = 'g1') {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/members`);
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

beforeEach(() => {
	vi.clearAllMocks();
	requireRateLimit.mockResolvedValue(null);
});

describe('GET /api/v1/groups/{gid}/members', () => {
	it('200 with member DTO rows; forwards { userId, groupId }', async () => {
		listMembers.mockResolvedValue([
			{ id: 'm1', displayName: 'Ann', userId: 'user_1', deactivatedAt: null, isLinked: true },
			{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
		]);
		const { status, body } = await read((await GET(makeEvent('g1'))) as Response);
		expect(status).toBe(200);
		expect(listMembers).toHaveBeenCalledWith({ userId: 'user_1', groupId: 'g1' });
		expect(body).toEqual([
			{ id: 'm1', displayName: 'Ann', userId: 'user_1', deactivatedAt: null, isLinked: true },
			{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
		]);
	});

	it('no access (GroupAccessError) → 404 not_found (conflated)', async () => {
		listMembers.mockRejectedValue(new GroupAccessError());
		const { status, body } = await read((await GET(makeEvent('secret'))) as Response);
		expect(status).toBe(404);
		expect(body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
	});
});
