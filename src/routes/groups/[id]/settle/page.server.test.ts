import { describe, expect, it, vi, beforeEach } from 'vitest';

// Route `load` tests for the settle page (task 5.4; PLAN §8, §8.2, §8.4).
//
// We mock the server deps (`requireGroupAccess`, `getGroupBalances`,
// `listMembers`) and assert the `load` contract directly — the §8 math itself is
// covered by `lib/transactions/balances.test.ts`, so here we verify the WIRING:
//   - balances ordered most-negative-first (§8.2) with display names + formatted
//     settlement amounts;
//   - suggestions mapped to display names + formatted amounts + raw minor amounts
//     (for the §8.4 prefill);
//   - the all-settled (no-suggestions) case sets `allSettled` and an empty list.

const { requireGroupAccess, getGroupBalances, listMembers } = vi.hoisted(() => ({
	requireGroupAccess: vi.fn(),
	getGroupBalances: vi.fn(),
	listMembers: vi.fn()
}));

vi.mock('$lib/server/access', () => ({ requireGroupAccess }));
vi.mock('$lib/server/balances', () => ({ getGroupBalances }));
vi.mock('$lib/server/members', () => ({ listMembers }));

import { load } from './+page.server';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

// Roster: Alice / Bob / Carol — note one is deactivated to confirm we still map
// names over the FULL roster (a deactivated member can still carry a balance).
const MEMBERS = [
	{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
	{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false },
	{
		id: 'm3',
		displayName: 'Carol',
		userId: null,
		deactivatedAt: '2026-01-01T00:00:00.000Z',
		isLinked: false
	}
];

function makeLoadEvent() {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL('http://localhost/groups/g1/settle')
	} as unknown as Parameters<typeof load>[0];
}

type LoadResult = {
	group: { id: string; name: string; settlementCurrency: string };
	balances: {
		memberId: string;
		displayName: string;
		balance: number;
		balanceFormatted: string;
		isDebtor: boolean;
		isCreditor: boolean;
	}[];
	suggestions: {
		fromMemberId: string;
		toMemberId: string;
		fromDisplayName: string;
		toDisplayName: string;
		amount: number;
		amountFormatted: string;
	}[];
	allSettled: boolean;
};

beforeEach(() => {
	requireGroupAccess.mockReset();
	getGroupBalances.mockReset();
	listMembers.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	listMembers.mockResolvedValue(MEMBERS);
});

describe('/groups/[id]/settle load', () => {
	it('orders balances most-negative-first (§8.2) with names + formatted amounts', async () => {
		// Bob owes 120.00 (−12000), Carol owes 30.00 (−3000), Alice is owed 150.00.
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 15000 },
			{ memberId: 'm2', balance: -12000 },
			{ memberId: 'm3', balance: -3000 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		// Most-negative first: Bob (−12000), Carol (−3000), Alice (+15000).
		expect(result.balances.map((b) => b.memberId)).toEqual(['m2', 'm3', 'm1']);
		expect(result.balances.map((b) => b.displayName)).toEqual(['Bob', 'Carol', 'Alice']);

		const bob = result.balances[0];
		expect(bob.balance).toBe(-12000);
		expect(bob.isDebtor).toBe(true);
		expect(bob.isCreditor).toBe(false);
		expect(bob.balanceFormatted).toContain('120.00');

		const alice = result.balances[2];
		expect(alice.isCreditor).toBe(true);
		expect(alice.isDebtor).toBe(false);

		expect(result.group.settlementCurrency).toBe('THB');
	});

	it('maps suggestions to display names + formatted + raw minor amounts (§8.4)', async () => {
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 15000 },
			{ memberId: 'm2', balance: -12000 },
			{ memberId: 'm3', balance: -3000 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.allSettled).toBe(false);
		// Greedy §8.3: largest debtor (Bob 12000) pays largest creditor (Alice 15000)
		// 12000; then Carol pays Alice 3000.
		expect(result.suggestions).toHaveLength(2);

		const first = result.suggestions[0];
		expect(first.fromMemberId).toBe('m2');
		expect(first.toMemberId).toBe('m1');
		expect(first.fromDisplayName).toBe('Bob');
		expect(first.toDisplayName).toBe('Alice');
		// Raw minor units preserved for the prefill link (no float parsing).
		expect(first.amount).toBe(12000);
		expect(first.amountFormatted).toContain('120.00');

		const second = result.suggestions[1];
		expect(second.fromMemberId).toBe('m3');
		expect(second.toMemberId).toBe('m1');
		expect(second.amount).toBe(3000);
	});

	it('reports all-settled with no suggestions when every balance is ~0', async () => {
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: 0 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.allSettled).toBe(true);
		expect(result.suggestions).toEqual([]);
		// Every member still listed (all settled), flagged neither debtor nor creditor.
		expect(result.balances).toHaveLength(2);
		expect(result.balances.every((b) => !b.isDebtor && !b.isCreditor)).toBe(true);
	});

	it('falls back to the member id when a balance has no roster name (defensive)', async () => {
		listMembers.mockResolvedValue([MEMBERS[0]]); // only Alice has a name
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 5000 },
			{ memberId: 'mX', balance: -5000 }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;
		const unnamed = result.balances.find((b) => b.memberId === 'mX');
		expect(unnamed?.displayName).toBe('mX');
	});
});
