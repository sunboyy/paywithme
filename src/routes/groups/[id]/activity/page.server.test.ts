import { describe, expect, it, vi, beforeEach } from 'vitest';

// Route `load` tests for the activity feed page (task 6.2; PLAN §12.1).
//
// We mock the server deps (`requireGroupAccess`, `listGroupActivity`,
// `listMembers`) and assert the `load` contract directly — the read query itself is
// covered by `lib/server/activity.test.ts`, so here we verify the WIRING:
//   - filter parsing from the URL (entity + actor), ignoring unrecognized entities;
//   - actor-filter options built from LINKED members only;
//   - the entries + filter state shape returned;
//   - a GroupAccessError race degrades to 404 (mirrors the txn list).

const { requireGroupAccess, listGroupActivity, listMembers } = vi.hoisted(() => ({
	requireGroupAccess: vi.fn(),
	listGroupActivity: vi.fn(),
	listMembers: vi.fn()
}));

vi.mock('$lib/server/access', () => ({ requireGroupAccess }));
vi.mock('$lib/server/activity', async () => {
	// Use the REAL parseEntityTypeFilter (pure) so we test the actual ignore-junk
	// behavior, but mock the DB-backed listGroupActivity.
	const actual =
		await vi.importActual<typeof import('$lib/server/activity')>('$lib/server/activity');
	return { ...actual, listGroupActivity };
});
vi.mock('$lib/server/members', () => ({ listMembers }));

import { load } from './+page.server';
import { GroupAccessError } from '$lib/server/groups';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

const MEMBERS = [
	{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
	{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false },
	{ id: 'm3', displayName: 'Carol', userId: 'u3', deactivatedAt: null, isLinked: true }
];

const ENTRIES = [
	{
		id: 'a1',
		action: 'create',
		entityType: 'transaction',
		entityId: 't1',
		summary: 'Created Dinner',
		metadata: null,
		occurredAt: '2026-06-15T10:00:00.000Z',
		actorUserId: 'u1',
		actorName: 'Alice'
	}
];

function makeLoadEvent(query = '') {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL(`http://localhost/groups/g1/activity${query}`)
	} as unknown as Parameters<typeof load>[0];
}

type LoadResult = {
	group: { id: string; name: string };
	entries: typeof ENTRIES;
	actors: { userId: string; displayName: string }[];
	entityTypes: string[];
	filters: { entity: string | null; actor: string | null };
};

beforeEach(() => {
	requireGroupAccess.mockReset();
	listGroupActivity.mockReset();
	listMembers.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	listMembers.mockResolvedValue(MEMBERS);
	listGroupActivity.mockResolvedValue(ENTRIES);
});

describe('/groups/[id]/activity load', () => {
	it('returns the feed, linked-only actor options, and entity types with no filters', async () => {
		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.group).toEqual({ id: 'g1', name: 'Trip' });
		expect(result.entries).toEqual(ENTRIES);
		// Actor options = LINKED members only (Bob has no userId → excluded).
		expect(result.actors).toEqual([
			{ userId: 'u1', displayName: 'Alice' },
			{ userId: 'u3', displayName: 'Carol' }
		]);
		// GROUP-scoped kinds only — the account-level `api_key` kind (PLAN §16.8) has
		// no group, so it is never offered as a group-feed filter.
		expect(result.entityTypes).toEqual(['transaction', 'member', 'invite', 'group']);
		expect(result.entityTypes).not.toContain('api_key');
		expect(result.filters).toEqual({ entity: null, actor: null });

		// No filters passed through to the service.
		expect(listGroupActivity).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { entityType: undefined, actorUserId: undefined }
		});
	});

	it('parses recognized entity + actor filters from the URL', async () => {
		const result = (await load(makeLoadEvent('?entity=member&actor=u3'))) as LoadResult;

		expect(result.filters).toEqual({ entity: 'member', actor: 'u3' });
		expect(listGroupActivity).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { entityType: 'member', actorUserId: 'u3' }
		});
	});

	it('ignores an unrecognized entity filter value', async () => {
		const result = (await load(makeLoadEvent('?entity=junk'))) as LoadResult;
		expect(result.filters.entity).toBeNull();
		expect(listGroupActivity).toHaveBeenCalledWith(
			expect.objectContaining({ filters: { entityType: undefined, actorUserId: undefined } })
		);
	});

	it('degrades a GroupAccessError race to 404', async () => {
		listGroupActivity.mockRejectedValue(new GroupAccessError());
		await expect(load(makeLoadEvent())).rejects.toMatchObject({ status: 404 });
	});

	it('degrades a non-access error to an empty feed (no 500)', async () => {
		listGroupActivity.mockRejectedValue(new Error('boom'));
		const result = (await load(makeLoadEvent())) as LoadResult;
		expect(result.entries).toEqual([]);
	});
});
