// Unit tests for the balances view (ADR-0008): the authoritative owed figure, its
// direction, and the sentence the model quotes.

import { describe, it, expect } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { MemberListItem } from '$lib/server/members';
import type { Group } from '$lib/server/groups';
import { toGroupView } from './group';
import { toMemberView } from './member';
import { balanceDirection, toBalancesView, BALANCES_NOTE } from './balance';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	name: 'test key',
	userId: 'user_me',
	permissions: null
};

const group = toGroupView(
	{
		id: 'grp_1',
		name: 'Japan Trip',
		settlementCurrency: 'THB',
		createdBy: 'user_bob',
		createdAt: new Date('2026-07-01T10:00:00.000Z'),
		deletedAt: null
	} as Group,
	principal
);

const roster: MemberListItem[] = [
	{ id: 'mem_me', displayName: 'Alice', userId: 'user_me', deactivatedAt: null, isLinked: true },
	{ id: 'mem_bob', displayName: 'Bob', userId: 'user_bob', deactivatedAt: null, isLinked: true }
];
const members = roster.map((m) => toMemberView(m, principal));

/** THB, exponent 2: the caller owes ฿1,200.00 and Bob is owed it. */
const balances = [
	{ memberId: 'mem_me', balance: -120000 },
	{ memberId: 'mem_bob', balance: 120000 }
];

describe('balanceDirection (§8.1 sign convention)', () => {
	it('a NEGATIVE balance means the member OWES', () => {
		expect(balanceDirection(-1)).toBe('owes');
	});
	it('a POSITIVE balance means the member IS OWED', () => {
		expect(balanceDirection(1)).toBe('is_owed');
	});
	it('zero is SETTLED', () => {
		expect(balanceDirection(0)).toBe('settled');
	});
});

describe('toBalancesView', () => {
	it('answers "how much do I owe?" with the server-computed figure, pre-worded', () => {
		const view = toBalancesView({ group, members, balances });

		expect(view.you).toEqual({
			memberId: 'mem_me',
			balance: { amount: '-1200.00', currency: 'THB', display: 'THB ฿-1,200.00' },
			direction: 'owes',
			// The MAGNITUDE, phrased — a model asked what it owes must not answer "−1,200".
			summary: 'You owe THB ฿1,200.00 in this group.'
		});
	});

	it('phrases a CREDIT as being owed, and a zero as settled', () => {
		const credited = toBalancesView({
			group,
			members,
			balances: [
				{ memberId: 'mem_me', balance: 45000 },
				{ memberId: 'mem_bob', balance: -45000 }
			]
		});
		expect(credited.you?.direction).toBe('is_owed');
		expect(credited.you?.summary).toBe('You are owed THB ฿450.00 in this group.');

		const square = toBalancesView({
			group,
			members,
			balances: [{ memberId: 'mem_me', balance: 0 }]
		});
		expect(square.you?.direction).toBe('settled');
		expect(square.you?.summary).toMatch(/settled up/i);
	});

	it('marks the caller’s line, and only the caller’s', () => {
		const view = toBalancesView({ group, members, balances });
		expect(view.balances.filter((b) => b.isYou).map((b) => b.memberId)).toEqual(['mem_me']);
	});

	it('every member NAME on a balance line is untrusted text (ADR-0003)', () => {
		const view = toBalancesView({ group, members, balances });

		for (const line of view.balances) {
			expect(line.displayName._untrusted).toBe(true);
			expect(line.displayName.author.kind).toBe('unknown');
		}
		expect(view.balances.map((b) => b.displayName.value)).toEqual(['Alice', 'Bob']);
		// The GROUP name too — Bob wrote it.
		expect(view.groupName).toEqual({
			_untrusted: true,
			value: 'Japan Trip',
			author: { kind: 'member', userId: 'user_bob' }
		});
	});

	it('re-shapes the amounts and NOTHING else: no re-summing, no rounding', () => {
		const view = toBalancesView({ group, members, balances });

		// Each figure is exactly the integer the balance service produced, rendered.
		expect(view.balances.map((b) => b.balance.amount)).toEqual(['-1200.00', '1200.00']);
		expect(view.settlementCurrency).toBe('THB');
	});

	it('carries the ADR-0008 prohibition IN THE PAYLOAD, not just in the tool description', () => {
		const view = toBalancesView({ group, members, balances });
		expect(view._note).toBe(BALANCES_NOTE);
		expect(view._note).toMatch(/authoritative/i);
		expect(view._note).toMatch(/never add up/i);
	});

	it('`you` is null when the caller has no active member row (and no line is falsely marked)', () => {
		const view = toBalancesView({
			group,
			members: [toMemberView(roster[1], principal)],
			balances: [{ memberId: 'mem_bob', balance: 0 }]
		});

		expect(view.you).toBeNull();
		expect(view.balances.every((b) => !b.isYou)).toBe(true);
	});

	it('keeps a balance line whose member is missing from the roster — never drops money', () => {
		const view = toBalancesView({
			group,
			members,
			balances: [...balances, { memberId: 'mem_ghost', balance: 500 }]
		});

		const ghost = view.balances.find((b) => b.memberId === 'mem_ghost');
		expect(ghost?.balance.amount).toBe('5.00');
		expect(ghost?.displayName.author).toEqual({ kind: 'paywithme' });
		expect(ghost?.isYou).toBe(false);
	});
});
