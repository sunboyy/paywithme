import { describe, expect, it, vi, beforeEach } from 'vitest';

// §8.4 settle-via-transfer PREFILL tests for the `new` transaction page `load`
// (task 5.4). The settle page links here with `?type=transfer&from&to&amount&category`
// to seed a Transfer (payer = debtor, single beneficiary = creditor, amount,
// category = Debt settlement). These tests use the REAL `superValidate` (NOT
// mocked — unlike `page.server.test.ts`) so we assert the ACTUAL seeded `form.data`:
//   - valid params → a transfer seeded with payer=debtor, lone beneficiary=creditor,
//     splitMode=equal, category=transfer-debt-settlement, amountTotal=amount;
//   - invalid params (from not in group, non-numeric amount, etc.) → the blank
//     spending default, WITHOUT throwing (the query string is never trusted).

const { getGroupForUser, listMembers, requireGroupAccess, requireUser } = vi.hoisted(() => ({
	getGroupForUser: vi.fn(),
	listMembers: vi.fn(),
	requireGroupAccess: vi.fn(),
	requireUser: vi.fn()
}));

vi.mock('$lib/server/groups', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/groups')>('$lib/server/groups');
	return { ...actual, getGroupForUser };
});
vi.mock('$lib/server/members', () => ({ listMembers }));
vi.mock('$lib/server/access', () => ({ requireGroupAccess, requireUser }));

import { load } from './+page.server';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };
const MEMBERS = [
	{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
	{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false },
	// A deactivated member — NOT in the active allow-list, so a prefill targeting it
	// must be rejected.
	{
		id: 'm3',
		displayName: 'Carol',
		userId: null,
		deactivatedAt: new Date('2026-01-01'),
		isLinked: false
	}
];

type SeededForm = {
	form: {
		data: {
			type: string;
			categoryId: string;
			amountTotal: number;
			amountTotalSettlement: number;
			splitMode: string;
			currency: string;
			payers: { memberId: string; amountPaid: number }[];
			beneficiaries: { memberId: string }[];
		};
	};
};

/** Build a `load` event whose URL carries the given query string. */
function makeLoadEvent(query = '') {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL(`http://localhost/groups/g1/transactions/new${query}`)
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	getGroupForUser.mockReset();
	listMembers.mockReset();
	requireGroupAccess.mockReset();
	requireUser.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	requireUser.mockReturnValue({ id: 'u1', name: 'Alice' });
	getGroupForUser.mockResolvedValue(GROUP);
	listMembers.mockResolvedValue(MEMBERS);
});

describe('/groups/[id]/transactions/new load — settle prefill (§8.4)', () => {
	it('seeds a Transfer from valid from/to/amount/category params', async () => {
		const result = (await load(
			makeLoadEvent('?type=transfer&from=m2&to=m1&amount=12000&category=transfer-debt-settlement')
		)) as SeededForm;
		const data = result.form.data;

		expect(data.type).toBe('transfer');
		expect(data.categoryId).toBe('transfer-debt-settlement');
		expect(data.splitMode).toBe('equal');
		// payer = debtor pays the whole amount.
		expect(data.payers).toEqual([{ memberId: 'm2', amountPaid: 12000 }]);
		// recipient = creditor is the lone (equal-split) beneficiary.
		expect(data.beneficiaries).toEqual([{ memberId: 'm1' }]);
		expect(data.amountTotal).toBe(12000);
		// Entry currency is the settlement currency → settlement total equals the amount.
		expect(data.amountTotalSettlement).toBe(12000);
		expect(data.currency).toBe('THB');
	});

	it('falls back to the blank spending default when params are absent', async () => {
		const result = (await load(makeLoadEvent())) as SeededForm;
		const data = result.form.data;
		expect(data.type).toBe('spending');
		expect(data.amountTotal).toBe(0);
		// Default beneficiaries = all active members (m1, m2); m3 is deactivated.
		expect(data.beneficiaries.map((b) => b.memberId)).toEqual(['m1', 'm2']);
	});

	it.each([
		['from not an active member', '?type=transfer&from=mX&to=m1&amount=100&category=transfer-cash'],
		[
			'to is a deactivated member',
			'?type=transfer&from=m1&to=m3&amount=100&category=transfer-cash'
		],
		[
			'from === to (self transfer)',
			'?type=transfer&from=m1&to=m1&amount=100&category=transfer-cash'
		],
		[
			'non-numeric amount',
			'?type=transfer&from=m2&to=m1&amount=abc&category=transfer-debt-settlement'
		],
		['float amount', '?type=transfer&from=m2&to=m1&amount=12.5&category=transfer-debt-settlement'],
		['zero amount', '?type=transfer&from=m2&to=m1&amount=0&category=transfer-debt-settlement'],
		['negative amount', '?type=transfer&from=m2&to=m1&amount=-5&category=transfer-debt-settlement'],
		[
			'a spending category id',
			'?type=transfer&from=m2&to=m1&amount=100&category=spending-food-drink'
		],
		['an unknown category id', '?type=transfer&from=m2&to=m1&amount=100&category=nope'],
		['type is not transfer', '?type=spending&from=m2&to=m1&amount=100&category=transfer-cash'],
		['missing to', '?type=transfer&from=m2&amount=100&category=transfer-cash']
	])('falls back to the blank default without throwing: %s', async (_label, query) => {
		const result = (await load(makeLoadEvent(query))) as SeededForm;
		const data = result.form.data;
		// Untrusted/invalid params must NEVER seed a transfer — blank spending default.
		expect(data.type).toBe('spending');
		expect(data.amountTotal).toBe(0);
		expect(data.beneficiaries.map((b) => b.memberId)).toEqual(['m1', 'm2']);
	});
});
