// Unit tests for the write-result ECHO-BACK (ADR-0004 + ADR-0006 + ADR-0003).
//
// The echo's whole job is LEGIBILITY: it restates a just-recorded spending in prose
// that names the humans, so a wrong pick or a misparsed amount is visible in the
// transcript. These tests pin the three things that must be true of that prose:
//   - the money is a DECIMAL string + currency + minor units (never a float);
//   - "you" is the caller (server-derived), other members are named for legibility;
//   - the split count and the beneficiary list read naturally.
// The load-bearing WRAPPED copy (`recorded`) is `toTransactionView`, tested in
// `transaction.test.ts`; here we build a `TransactionView` through that same mapper
// so the echo is exercised over a realistic, already-wrapped input.

import { describe, it, expect } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { MemberListItem } from '$lib/server/members';
import type { TransactionDetail } from '$lib/server/transactions';
import { toMemberView } from './member';
import { toTransactionView } from './transaction';
import { buildEchoBack } from './echo';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	name: 'test key',
	userId: 'user_me',
	permissions: null
};

const roster: MemberListItem[] = [
	{ id: 'mem_me', displayName: 'Alice', userId: 'user_me', deactivatedAt: null, isLinked: true },
	{
		id: 'mem_nan',
		displayName: 'Nan Suphaporn',
		userId: 'user_nan',
		deactivatedAt: null,
		isLinked: true
	},
	{ id: 'mem_bob', displayName: 'Bob', userId: 'user_bob', deactivatedAt: null, isLinked: true }
];
const members = roster.map((m) => toMemberView(m, principal));

/** A THB-settlement spending recorded by the caller, paid by them, split with others. */
function detail(overrides: Partial<TransactionDetail> = {}): TransactionDetail {
	const base: TransactionDetail = {
		id: 'txn_1',
		groupId: 'grp_1',
		type: 'spending',
		title: 'Lunch',
		categoryId: 'spending-food-drink',
		categoryName: 'Food & Drink',
		categoryIcon: 'utensils',
		createdBy: 'user_me',
		amountTotal: 24000,
		currency: 'THB',
		amountTotalSettlement: 24000,
		settlementCurrency: 'THB',
		isForeign: false,
		splitMode: 'equal',
		createdAt: '2026-07-15T12:00:00.000Z',
		deletedAt: null,
		payers: [{ memberId: 'mem_me', amountPaid: 24000 }],
		shares: [
			{ memberId: 'mem_me', amountOwed: 12000 },
			{ memberId: 'mem_nan', amountOwed: 12000 }
		],
		items: [],
		charges: [],
		input: {} as TransactionDetail['input']
	};
	return { ...base, ...overrides };
}

function echoFor(overrides: Partial<TransactionDetail> = {}, minor = 24000): string {
	const view = toTransactionView({ detail: detail(overrides), members, principal });
	return buildEchoBack({ view, minorUnits: minor });
}

describe('buildEchoBack', () => {
	it('names the humans and states the money as a decimal + minor units (ADR-0004)', () => {
		const echo = echoFor();
		// The money is the decimal string in the settlement currency, plus its integer
		// minor units — a misparse (฿2.40) would be visible here, not buried in the DB.
		expect(echo).toContain('THB 240.00 (24000 minor units)');
		// The caller is "you"; the other beneficiary is named for legibility.
		expect(echo).toBe(
			'Recorded spending "Lunch" — THB 240.00 (24000 minor units), paid by you, ' +
				'split equally 2 ways: you and Nan Suphaporn.'
		);
	});

	it('speaks the title verbatim (the wrapped copy in `recorded` is where it is DATA)', () => {
		const echo = echoFor({ title: 'Team dinner' });
		expect(echo).toContain('"Team dinner"');
	});

	it('names a payer who is NOT you by their display name', () => {
		const echo = echoFor({
			createdBy: 'user_nan',
			payers: [{ memberId: 'mem_nan', amountPaid: 24000 }]
		});
		expect(echo).toContain('paid by Nan Suphaporn');
	});

	it('reads "1 way" for a solo split and lists a single beneficiary', () => {
		const echo = echoFor({ shares: [{ memberId: 'mem_me', amountOwed: 24000 }] });
		expect(echo).toContain('split equally 1 way: you.');
	});

	it('joins three or more beneficiaries with commas and a trailing "and"', () => {
		const echo = echoFor({
			shares: [
				{ memberId: 'mem_me', amountOwed: 8000 },
				{ memberId: 'mem_bob', amountOwed: 8000 },
				{ memberId: 'mem_nan', amountOwed: 8000 }
			]
		});
		expect(echo).toContain('split equally 3 ways: you, Bob and Nan Suphaporn.');
	});

	it('renders a 0-exponent currency with no decimal point (JPY, ADR-0004)', () => {
		const echo = echoFor(
			{
				currency: 'JPY',
				settlementCurrency: 'JPY',
				amountTotal: 2400,
				amountTotalSettlement: 2400,
				payers: [{ memberId: 'mem_me', amountPaid: 2400 }],
				shares: [{ memberId: 'mem_me', amountOwed: 2400 }]
			},
			2400
		);
		expect(echo).toContain('JPY 2400 (2400 minor units)');
	});
});
