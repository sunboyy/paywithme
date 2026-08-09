import { describe, expect, it, vi, beforeEach } from 'vitest';

// Route `load` tests for the group overview page.
//
// We mock the server deps and assert the `load` contract:
//   - balances ordered most-negative-first with display names + formatted amounts;
//   - recentTransactions and recentActivity slices passed through from the services;
//   - a GroupAccessError race in any parallel fetch degrades to 404;
//   - a non-access error in a fetch degrades gracefully to an empty list.

const { requireGroupAccess, getGroupBalances, listMembers, listTransactions, listGroupActivity } =
	vi.hoisted(() => ({
		requireGroupAccess: vi.fn(),
		getGroupBalances: vi.fn(),
		listMembers: vi.fn(),
		listTransactions: vi.fn(),
		listGroupActivity: vi.fn()
	}));

vi.mock('$lib/server/access', () => ({ requireGroupAccess }));
vi.mock('$lib/server/balances', () => ({ getGroupBalances }));
vi.mock('$lib/server/members', () => ({ listMembers }));
vi.mock('$lib/server/transactions', () => ({ listTransactions }));
vi.mock('$lib/server/activity', () => ({ listGroupActivity }));

import { load } from './+page.server';
import { GroupAccessError } from '$lib/server/groups';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

const MEMBERS = [
	{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
	{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
];

const TRANSACTIONS = [
	{
		id: 't1',
		type: 'spending' as const,
		title: 'Dinner',
		categoryId: 'cat1',
		categoryName: 'Food',
		categoryIcon: 'utensils',
		amountTotal: 9000,
		currency: 'THB' as const,
		amountTotalSettlement: 9000,
		settlementCurrency: 'THB' as const,
		isForeign: false,
		createdAt: '2026-06-15T12:00:00.000Z'
	}
];

const ACTIVITY = [
	{
		id: 'a1',
		action: 'create',
		entityType: 'transaction',
		entityId: 't1',
		summary: 'Added spending "Dinner" — ฿90.00',
		metadata: null,
		occurredAt: '2026-06-15T12:00:01.000Z',
		actorUserId: 'u1',
		actorName: 'Alice'
	}
];

type BalanceRow = {
	memberId: string;
	displayName: string;
	balance: number;
	balanceFormatted: string;
	isDebtor: boolean;
	isCreditor: boolean;
	isActive: boolean;
	isYou: boolean;
};

type Summary = {
	balance: number;
	amountFormatted: string;
	counterparties: number;
} | null;

type LoadResult = {
	group: { id: string; name: string; settlementCurrency: string };
	summary: Summary;
	balances: BalanceRow[];
	recentTransactions: typeof TRANSACTIONS;
	recentActivity: typeof ACTIVITY;
};

function makeLoadEvent() {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL('http://localhost/groups/g1')
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	requireGroupAccess.mockReset();
	getGroupBalances.mockReset();
	listMembers.mockReset();
	listTransactions.mockReset();
	listGroupActivity.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	getGroupBalances.mockResolvedValue([
		{ memberId: 'm1', balance: 5000 },
		{ memberId: 'm2', balance: -5000 }
	]);
	listMembers.mockResolvedValue(MEMBERS);
	listTransactions.mockResolvedValue(TRANSACTIONS);
	listGroupActivity.mockResolvedValue(ACTIVITY);
});

describe('/groups/[id] overview load', () => {
	it('returns group, balances ordered most-negative-first, recent transactions, and recent activity', async () => {
		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.group).toEqual({ id: 'g1', name: 'Trip', settlementCurrency: 'THB' });

		// Most-negative first: Bob (−5000) before Alice (+5000).
		expect(result.balances.map((b) => b.memberId)).toEqual(['m2', 'm1']);
		expect(result.balances.map((b) => b.displayName)).toEqual(['Bob', 'Alice']);

		const bob = result.balances[0];
		expect(bob.isDebtor).toBe(true);
		expect(bob.isCreditor).toBe(false);
		expect(bob.balanceFormatted).toContain('50.00');

		const alice = result.balances[1];
		expect(alice.isDebtor).toBe(false);
		expect(alice.isCreditor).toBe(true);

		expect(result.recentTransactions).toEqual(TRANSACTIONS);
		expect(result.recentActivity).toEqual(ACTIVITY);
	});

	it('requests exactly 5 recent transactions and 5 recent activity entries', async () => {
		await load(makeLoadEvent());

		expect(listTransactions).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'u1', groupId: 'g1', limit: 5 })
		);
		expect(listGroupActivity).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'u1', groupId: 'g1', limit: 5 })
		);
	});

	it('degrades a GroupAccessError race in balances to 404', async () => {
		getGroupBalances.mockRejectedValue(new GroupAccessError());
		await expect(load(makeLoadEvent())).rejects.toMatchObject({ status: 404 });
	});

	it('degrades a non-access error in transactions to an empty list', async () => {
		listTransactions.mockRejectedValue(new Error('db gone'));
		const result = (await load(makeLoadEvent())) as LoadResult;
		expect(result.recentTransactions).toEqual([]);
	});

	it('degrades a non-access error in activity to an empty list', async () => {
		listGroupActivity.mockRejectedValue(new Error('db gone'));
		const result = (await load(makeLoadEvent())) as LoadResult;
		expect(result.recentActivity).toEqual([]);
	});

	it('falls back to member id as display name when roster has no matching entry', async () => {
		listMembers.mockResolvedValue([MEMBERS[0]]); // only Alice
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 5000 },
			{ memberId: 'mX', balance: -5000 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;
		const unknown = result.balances.find((b) => b.memberId === 'mX');
		expect(unknown?.displayName).toBe('mX');
	});
});

// ── The viewer's own position (the hero summary on the overview) ───────────────
// `u1` is linked to member `m1`; `m2` (Bob) is an unlinked participant.
describe('/groups/[id] viewer summary', () => {
	it("summarises the CALLER's balance, not the first row's", async () => {
		// Bob is most-negative so he sorts first; the summary must still be Alice's.
		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.summary).not.toBeNull();
		expect(result.summary!.balance).toBe(5000);
		// Absolute value — the UI supplies "You are owed" / "You owe" wording.
		expect(result.summary!.amountFormatted).toContain('50.00');
		expect(result.summary!.amountFormatted).not.toContain('-');
	});

	it('formats a DEBT without a sign so "You owe -฿50.00" cannot render', async () => {
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: -5000 },
			{ memberId: 'm2', balance: 5000 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.summary!.balance).toBe(-5000);
		expect(result.summary!.amountFormatted).not.toContain('-');
	});

	it('counts only the members on the OTHER side of the balance', async () => {
		// Alice is owed; m2 and m3 owe, m4 is square → 2 counterparties.
		listMembers.mockResolvedValue([
			...MEMBERS,
			{ id: 'm3', displayName: 'Cara', userId: null, deactivatedAt: null, isLinked: false },
			{ id: 'm4', displayName: 'Dan', userId: null, deactivatedAt: null, isLinked: false }
		]);
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 8000 },
			{ memberId: 'm2', balance: -5000 },
			{ memberId: 'm3', balance: -3000 },
			{ memberId: 'm4', balance: 0 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.summary!.counterparties).toBe(2);
	});

	it('reports a settled viewer as balance 0 (not as "no summary")', async () => {
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: 0 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.summary).not.toBeNull();
		expect(result.summary!.balance).toBe(0);
	});

	it('omits the summary when the caller has no member row in the group', async () => {
		// No member carries userId 'u1' — better no summary than a wrong one.
		listMembers.mockResolvedValue([
			{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
		]);
		getGroupBalances.mockResolvedValue([{ memberId: 'm2', balance: 0 }]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.summary).toBeNull();
	});

	it("flags the caller's own row in the balances list", async () => {
		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.balances.find((b) => b.memberId === 'm1')!.isYou).toBe(true);
		expect(result.balances.find((b) => b.memberId === 'm2')!.isYou).toBe(false);
	});
});
