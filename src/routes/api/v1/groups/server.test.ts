// Unit test for GET /api/v1/groups (PLAN §16.4).
//
// HTTP-boundary test with a REAL principal + the REAL `toGroupDto` mapper; only the
// underlying `listGroupsForUser` read is mocked. Asserts the happy path returns
// 200 with DTO-shaped rows, that the internal `deletedAt` is DROPPED from the wire,
// and that the principal's `userId` is forwarded to the read function.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listGroupsForUser } = vi.hoisted(() => ({ listGroupsForUser: vi.fn() }));
vi.mock('$lib/server/groups', () => ({ listGroupsForUser }));

import { GET } from './+server';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	userId: 'user_1',
	permissions: { api: ['read'] }
};

function makeEvent(apiKey: ApiKeyPrincipal | null = principal) {
	const url = new URL('http://localhost/api/v1/groups');
	return {
		locals: { apiKey },
		url,
		request: new Request(url),
		params: {}
	} as unknown as Parameters<typeof GET>[0];
}

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

function groupRow(over: Partial<Record<string, unknown>> = {}) {
	return {
		id: 'g1',
		name: 'Trip',
		settlementCurrency: 'THB',
		createdBy: 'user_1',
		createdAt: new Date('2026-01-02T03:04:05.000Z'),
		deletedAt: null,
		...over
	};
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/groups', () => {
	it('200 with DTO rows; forwards the principal userId', async () => {
		listGroupsForUser.mockResolvedValue([groupRow(), groupRow({ id: 'g2', name: 'Lunch' })]);
		const { status, body } = await read((await GET(makeEvent())) as Response);
		expect(status).toBe(200);
		expect(listGroupsForUser).toHaveBeenCalledWith('user_1');
		expect(body).toHaveLength(2);
		expect(body[0]).toEqual({
			id: 'g1',
			name: 'Trip',
			settlementCurrency: 'THB',
			createdBy: 'user_1',
			createdAt: '2026-01-02T03:04:05.000Z'
		});
	});

	it('drops the internal deletedAt field from every row', async () => {
		listGroupsForUser.mockResolvedValue([groupRow({ deletedAt: new Date() })]);
		const { body } = await read((await GET(makeEvent())) as Response);
		expect(body[0]).not.toHaveProperty('deletedAt');
	});

	it('401 when the principal is somehow absent (defensive guard)', async () => {
		const { status, body } = await read((await GET(makeEvent(null))) as Response);
		expect(status).toBe(401);
		expect(body.error.code).toBe('unauthorized');
	});
});
