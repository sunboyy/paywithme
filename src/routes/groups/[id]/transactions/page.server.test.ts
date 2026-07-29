import { describe, expect, it, vi, beforeEach } from 'vitest';

// Route test for the transaction list `load` (task 4.7): the filter state is
// parsed from `url.searchParams` and passed to `listTransactions`; the shaped
// rows + filter state come back. Services are mocked (no real DB).

const { listTransactions, requireGroupAccess, listMembers } = vi.hoisted(() => ({
	listTransactions: vi.fn(),
	requireGroupAccess: vi.fn(),
	listMembers: vi.fn()
}));

vi.mock('$lib/server/transactions', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/transactions')>(
		'$lib/server/transactions'
	);
	return { ...actual, listTransactions };
});
vi.mock('$lib/server/access', () => ({ requireGroupAccess }));
vi.mock('$lib/server/members', () => ({ listMembers }));

import { load } from './+page.server';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

function makeLoadEvent(search: string) {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL(`http://localhost/groups/g1/transactions${search}`)
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	listTransactions.mockReset();
	requireGroupAccess.mockReset();
	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	listTransactions.mockResolvedValue([]);
	listMembers.mockReset();
	// Two members: the viewer (linked to u1) and one other participant slot.
	listMembers.mockResolvedValue([
		{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
		{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
	]);
});

describe('/groups/[id]/transactions load', () => {
	it('parses no filters when the query string is empty', async () => {
		const result = (await load(makeLoadEvent(''))) as {
			filters: { type: string | null; category: string | null };
			transactions: unknown[];
			currency: { code: string };
		};
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined }
		});
		// Exhaustive on purpose: `filters` is the page's whole filter state, and the
		// §10 member filter added `member`/`role` to it (both null when unset).
		expect(result.filters).toEqual({ type: null, category: null, member: null, role: null });
		expect(result.currency.code).toBe('THB');
	});

	it('parses the type + category filters from the URL', async () => {
		const result = (await load(makeLoadEvent('?type=transfer&category=transfer-cash'))) as {
			filters: { type: string | null; category: string | null };
		};

		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: 'transfer', categoryId: 'transfer-cash' }
		});
		expect(result.filters).toEqual({
			type: 'transfer',
			category: 'transfer-cash',
			member: null,
			role: null
		});
	});

	it('ignores an unrecognized type value (no filter)', async () => {
		await load(makeLoadEvent('?type=bogus'));
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined }
		});
	});

	it('returns the shaped transactions from the service', async () => {
		listTransactions.mockResolvedValueOnce([
			{
				id: 't1',
				type: 'spending',
				title: 'Dinner',
				categoryId: 'spending-food-drink',
				categoryName: 'Food & Drink',
				categoryIcon: 'utensils',
				amountTotalSettlement: 9000,
				settlementCurrency: 'THB',
				createdAt: '2026-03-01T00:00:00.000Z'
			}
		]);
		const result = (await load(makeLoadEvent(''))) as { transactions: { id: string }[] };
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].id).toBe('t1');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The §10 MEMBER filter — "show only what relates to me (or another person)".
// ─────────────────────────────────────────────────────────────────────────────

describe('/groups/[id]/transactions load — member filter (PLAN §10)', () => {
	type MemberResult = {
		filters: { member: string | null; role: string | null };
		members: { id: string; isSelf: boolean; isInactive: boolean }[];
	};

	it('passes the member filter through and echoes it back', async () => {
		const result = (await load(makeLoadEvent('?member=m1'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: undefined }
		});
		expect(result.filters.member).toBe('m1');
		expect(result.filters.role).toBeNull();
	});

	it.each(['paid', 'owes'] as const)(
		'passes role=%s through alongside the member',
		async (role) => {
			const result = (await load(makeLoadEvent(`?member=m1&role=${role}`))) as MemberResult;
			expect(listTransactions).toHaveBeenCalledWith({
				userId: 'u1',
				groupId: 'g1',
				filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: role }
			});
			expect(result.filters.role).toBe(role);
		}
	);

	it('ignores an unrecognized role value (falls back to EITHER side)', async () => {
		const result = (await load(makeLoadEvent('?member=m1&role=bogus'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: undefined }
		});
		expect(result.filters.role).toBeNull();
	});

	it('DROPS a role given without a member — it never reaches the service', async () => {
		const result = (await load(makeLoadEvent('?role=paid'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: undefined,
				categoryId: undefined,
				memberId: undefined,
				memberRole: undefined
			}
		});
		expect(result.filters.role).toBeNull();
	});

	it('treats an empty member param as no filter', async () => {
		const result = (await load(makeLoadEvent('?member='))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: undefined,
				categoryId: undefined,
				memberId: undefined,
				memberRole: undefined
			}
		});
		expect(result.filters.member).toBeNull();
	});

	it('composes with the type + category filters', async () => {
		await load(makeLoadEvent('?type=spending&category=spending-food-drink&member=m2&role=owes'));
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: 'spending',
				categoryId: 'spending-food-drink',
				memberId: 'm2',
				memberRole: 'owes'
			}
		});
	});

	it('returns the group members, marking the viewer as self', async () => {
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(listMembers).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.members).toEqual([
			{ id: 'm1', displayName: 'Alice', isSelf: true, isInactive: false },
			{ id: 'm2', displayName: 'Bob', isSelf: false, isInactive: false }
		]);
	});

	it('keeps DEACTIVATED members selectable, marked inactive (§6.3 — they keep their history)', async () => {
		listMembers.mockResolvedValueOnce([
			{
				id: 'm3',
				displayName: 'Carol',
				userId: null,
				deactivatedAt: '2026-02-01T00:00:00.000Z',
				isLinked: false
			}
		]);
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(result.members).toEqual([
			{ id: 'm3', displayName: 'Carol', isSelf: false, isInactive: true }
		]);
	});

	it('degrades to no member filter (rather than 500) when the member read fails', async () => {
		listMembers.mockRejectedValueOnce(new Error('db down'));
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(result.members).toEqual([]);
	});
});
