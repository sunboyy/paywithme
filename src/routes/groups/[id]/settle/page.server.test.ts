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
//
// Issue #86 adds the creditor's receiving details (PLAN §8.4, §17.3–§17.4). The
// view builder is mocked here — its own spec is `lib/server/receiving-view.test.ts`
// — so what this file checks is the WIRING that only the route can get wrong:
// WHOSE details are read (creditors, nobody else), that they are read through the
// `listForViewer`-only builder, and when the invite link is fetched at all.

const {
	requireGroupAccess,
	getGroupBalances,
	listMembers,
	loadReceivingProfiles,
	listActiveInvites
} = vi.hoisted(() => ({
	requireGroupAccess: vi.fn(),
	getGroupBalances: vi.fn(),
	listMembers: vi.fn(),
	loadReceivingProfiles: vi.fn(),
	listActiveInvites: vi.fn()
}));

vi.mock('$lib/server/access', () => ({ requireGroupAccess }));
vi.mock('$lib/server/balances', () => ({ getGroupBalances }));
vi.mock('$lib/server/members', () => ({ listMembers }));
vi.mock('$lib/server/receiving-view', () => ({ loadReceivingProfiles }));
vi.mock('$lib/server/invites', () => ({ listActiveInvites }));

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
		key: string;
		fromMemberId: string;
		toMemberId: string;
		fromDisplayName: string;
		toDisplayName: string;
		amount: number;
		amountFormatted: string;
	}[];
	allSettled: boolean;
	receiving: Record<string, { state: string }>;
	inviteUrl: string | null;
};

/** Bob (m2) and Carol (m3) each owe Alice (m1) — Alice is the only creditor. */
function balancesOwedToAlice() {
	getGroupBalances.mockResolvedValue([
		{ memberId: 'm1', balance: 15000 },
		{ memberId: 'm2', balance: -12000 },
		{ memberId: 'm3', balance: -3000 }
	]);
}

beforeEach(() => {
	requireGroupAccess.mockReset();
	getGroupBalances.mockReset();
	listMembers.mockReset();

	loadReceivingProfiles.mockReset();
	listActiveInvites.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	listMembers.mockResolvedValue(MEMBERS);
	loadReceivingProfiles.mockResolvedValue({});
	listActiveInvites.mockResolvedValue([]);
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

describe('the creditor’s receiving details (issue #86; PLAN §8.4, §17.3–§17.4)', () => {
	it('reads only the members a suggestion names as the creditor', async () => {
		balancesOwedToAlice();

		await load(makeLoadEvent());

		// Alice (m1) is owed; Bob and Carol are paying. Only Alice's details belong
		// on this page — nobody's account is loaded because they happen to be in the
		// group. Both rows name her, and both go through one read of her profile.
		expect(loadReceivingProfiles).toHaveBeenCalledWith(
			'u1',
			[
				{ id: 'm2→m1', userId: 'u1', amount: { amount: 12000, currency: 'THB' } },
				{ id: 'm3→m1', userId: 'u1', amount: { amount: 3000, currency: 'THB' } }
			],
			{ promptViewerToAdd: true }
		);
	});

	it('asks for each transfer’s OWN amount (issue #88)', async () => {
		// One creditor, two debtors, two different figures. The QR in each row carries
		// that row's amount, so the details are requested per transfer — a per-creditor
		// request could only ever put one of the two figures in front of both payers.
		balancesOwedToAlice();

		await load(makeLoadEvent());

		const targets = loadReceivingProfiles.mock.calls[0][1] as {
			id: string;
			amount: { amount: number };
		}[];
		expect(targets.map((t) => t.amount.amount)).toEqual([12000, 3000]);
		expect(new Set(targets.map((t) => t.id)).size).toBe(2);
	});

	it('keys the details by the same key the suggestions carry', async () => {
		balancesOwedToAlice();

		const result = (await load(makeLoadEvent())) as LoadResult;

		const targets = loadReceivingProfiles.mock.calls[0][1] as { id: string }[];
		expect(result.suggestions.map((s) => s.key)).toEqual(targets.map((t) => t.id));
	});

	it('loads nobody’s details when the group is all settled', async () => {
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: 0 }
		]);

		await load(makeLoadEvent());

		expect(loadReceivingProfiles).toHaveBeenCalledWith('u1', [], { promptViewerToAdd: true });
	});

	it('hands the page the view keyed by suggested transfer', async () => {
		balancesOwedToAlice();
		loadReceivingProfiles.mockResolvedValue({ 'm2→m1': { state: 'methods', methods: [] } });

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.receiving['m2→m1'].state).toBe('methods');
	});

	it('fetches the group’s newest invite link when a creditor is unlinked', async () => {
		// Empty state 1 (§17.4): the only thing that will ever help here is an invite.
		balancesOwedToAlice();
		loadReceivingProfiles.mockResolvedValue({ 'm2→m1': { state: 'unlinked' } });
		listActiveInvites.mockResolvedValue([
			{ id: 'i1', token: 'tok_new', expiresAt: '', createdAt: '' },
			{ id: 'i2', token: 'tok_old', expiresAt: '', createdAt: '' }
		]);

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(listActiveInvites).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.inviteUrl).toBe('http://localhost/invite/tok_new');
	});

	it('does not read the viewer’s own profile when they owe rather than are owed', async () => {
		// PLAN §17.4 case 3 only fires for a CREDITOR. Alice (u1/m1) is paying here,
		// so her member is not among the targets and no `own-empty` can be produced.
		getGroupBalances.mockResolvedValue([
			{ memberId: 'm1', balance: -12000 },
			{ memberId: 'm2', balance: 12000 }
		]);

		await load(makeLoadEvent());

		expect(loadReceivingProfiles).toHaveBeenCalledWith(
			'u1',
			[{ id: 'm1→m2', userId: null, amount: { amount: 12000, currency: 'THB' } }],
			{ promptViewerToAdd: true }
		);
	});

	it('opts into the case-3 prompt, because BEING A CREDITOR is what earns it', async () => {
		// The targets are already filtered to creditors, so the flag can only ever
		// reach the viewer on a row that says someone owes them money (PLAN §17.4).
		balancesOwedToAlice();

		await load(makeLoadEvent());

		expect(loadReceivingProfiles.mock.calls[0][2]).toEqual({ promptViewerToAdd: true });
	});

	it('does not go looking for an invite link when every creditor has an account', async () => {
		balancesOwedToAlice();
		loadReceivingProfiles.mockResolvedValue({ 'm2→m1': { state: 'no-methods' } });

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(listActiveInvites).not.toHaveBeenCalled();
		expect(result.inviteUrl).toBeNull();
	});

	it('renders the page without an invite link rather than failing on one', async () => {
		// A transient invites failure costs the nudge, not the settle screen.
		balancesOwedToAlice();
		loadReceivingProfiles.mockResolvedValue({ 'm2→m1': { state: 'unlinked' } });
		listActiveInvites.mockRejectedValue(new Error('boom'));

		const result = (await load(makeLoadEvent())) as LoadResult;

		expect(result.inviteUrl).toBeNull();
		expect(result.suggestions).toHaveLength(2);
	});
});
