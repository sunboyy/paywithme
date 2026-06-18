import { describe, it, expect } from 'vitest';

// Unit tests for the PURE net-balance core (PLAN §8.1, task 5.1). No DB, no mocks —
// just the integer money math: balance(member) = Σ paid_settlement − Σ owed, with
// every member present (incl. zero-balance) and Σ of all balances == 0.

import { computeBalances, orderByWhoShouldPay, type MemberBalance } from './balances';

/** Sum of all balances — must be exactly 0 for a well-formed group (§8.1). */
function totalBalance(balances: { balance: number }[]): number {
	return balances.reduce((acc, b) => acc + b.balance, 0);
}

describe('computeBalances (PLAN §8.1)', () => {
	it('two members, one pays, both owe equally → correct signs, sums to 0', () => {
		// m1 paid the whole 9000 bill; both owe 4500.
		const result = computeBalances({
			paidByMember: new Map([['m1', 9000]]),
			owedByMember: new Map([
				['m1', 4500],
				['m2', 4500]
			]),
			memberIds: ['m1', 'm2']
		});
		expect(result).toEqual([
			{ memberId: 'm1', balance: 4500 }, // paid 9000 − owed 4500 = +4500 (creditor)
			{ memberId: 'm2', balance: -4500 } // paid 0 − owed 4500 = −4500 (debtor)
		]);
		expect(totalBalance(result)).toBe(0);
	});

	it('multi-member mixed paid/owed → each balance correct AND Σ balances === 0', () => {
		// A 12000 dinner: m1 paid 7000, m2 paid 5000, m3 paid 0.
		// Owed: m1 3000, m2 4000, m3 5000 (sums to 12000 == total paid).
		const result = computeBalances({
			paidByMember: new Map([
				['m1', 7000],
				['m2', 5000]
			]),
			owedByMember: new Map([
				['m1', 3000],
				['m2', 4000],
				['m3', 5000]
			]),
			memberIds: ['m1', 'm2', 'm3']
		});
		expect(result).toEqual([
			{ memberId: 'm1', balance: 4000 }, // 7000 − 3000
			{ memberId: 'm2', balance: 1000 }, // 5000 − 4000
			{ memberId: 'm3', balance: -5000 } // 0 − 5000
		]);
		// CRUX (§8.1): the whole group nets to exactly 0.
		expect(totalBalance(result)).toBe(0);
	});

	it('a member who neither paid nor owed appears with balance 0', () => {
		const result = computeBalances({
			paidByMember: new Map([['m1', 9000]]),
			owedByMember: new Map([
				['m1', 4500],
				['m2', 4500]
			]),
			// m3 is on the roster but isn't in either map.
			memberIds: ['m1', 'm2', 'm3']
		});
		expect(result).toContainEqual({ memberId: 'm3', balance: 0 });
		expect(result).toHaveLength(3);
		expect(totalBalance(result)).toBe(0);
	});

	it('a pure creditor (only paid) and a pure debtor (only owes)', () => {
		// m1 paid 5000 and owes nothing → +5000; m2 owes 5000 and paid nothing → −5000.
		const result = computeBalances({
			paidByMember: new Map([['m1', 5000]]),
			owedByMember: new Map([['m2', 5000]]),
			memberIds: ['m1', 'm2']
		});
		expect(result).toEqual([
			{ memberId: 'm1', balance: 5000 },
			{ memberId: 'm2', balance: -5000 }
		]);
		expect(totalBalance(result)).toBe(0);
	});

	it('empty group / no transactions → empty result, sums to 0', () => {
		expect(
			computeBalances({ paidByMember: new Map(), owedByMember: new Map(), memberIds: [] })
		).toEqual([]);
	});

	it('all-zero roster (members exist, no activity) → every member 0', () => {
		const result = computeBalances({
			paidByMember: new Map(),
			owedByMember: new Map(),
			memberIds: ['m1', 'm2']
		});
		expect(result).toEqual([
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: 0 }
		]);
		expect(totalBalance(result)).toBe(0);
	});

	it('preserves the roster order, then appends any map-only id (ascending)', () => {
		// `mz` appears only in the maps, not on the roster — still included so its
		// amount never vanishes from the zero-sum, sorted after the roster ids.
		const result = computeBalances({
			paidByMember: new Map([['mz', 1000]]),
			owedByMember: new Map([
				['m2', 1000],
				['m1', 0]
			]),
			memberIds: ['m2', 'm1']
		});
		expect(result.map((b) => b.memberId)).toEqual(['m2', 'm1', 'mz']);
		expect(totalBalance(result)).toBe(0);
	});

	it('all amounts stay integers (minor units) — no floats introduced', () => {
		const result = computeBalances({
			paidByMember: new Map([
				['m1', 3333],
				['m2', 3333],
				['m3', 3334]
			]),
			owedByMember: new Map([
				['m1', 3333],
				['m2', 3334],
				['m3', 3333]
			]),
			memberIds: ['m1', 'm2', 'm3']
		});
		for (const { balance } of result) {
			expect(Number.isInteger(balance)).toBe(true);
		}
		expect(result).toEqual([
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: -1 },
			{ memberId: 'm3', balance: 1 }
		]);
		expect(totalBalance(result)).toBe(0);
	});
});

describe('orderByWhoShouldPay (PLAN §8.2)', () => {
	it('sorts most-negative first → debtors before creditors', () => {
		// Mixed set, deliberately NOT pre-sorted, sums to 0.
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 4000 }, // creditor
			{ memberId: 'm2', balance: 1000 }, // small creditor
			{ memberId: 'm3', balance: -5000 } // biggest debtor → should pay first
		];
		expect(orderByWhoShouldPay(balances)).toEqual([
			{ memberId: 'm3', balance: -5000 },
			{ memberId: 'm2', balance: 1000 },
			{ memberId: 'm1', balance: 4000 }
		]);
	});

	it('breaks ties on equal balance by memberId ascending (deterministic)', () => {
		// Two debtors with the SAME balance: 'mb' must come before 'mc' (ascending).
		// Input order is reversed to prove the order is driven by the tie-break, not
		// by input position.
		const balances: MemberBalance[] = [
			{ memberId: 'mc', balance: -2000 },
			{ memberId: 'ma', balance: 4000 },
			{ memberId: 'mb', balance: -2000 }
		];
		const ordered = orderByWhoShouldPay(balances);
		expect(ordered.map((b) => b.memberId)).toEqual(['mb', 'mc', 'ma']);
		// Re-running on a different input order yields the SAME deterministic result.
		const reordered = orderByWhoShouldPay([...balances].reverse());
		expect(reordered.map((b) => b.memberId)).toEqual(['mb', 'mc', 'ma']);
	});

	it('does NOT mutate the input array (frozen input is safe)', () => {
		const balances: readonly MemberBalance[] = Object.freeze([
			{ memberId: 'm1', balance: 5000 },
			{ memberId: 'm2', balance: -5000 }
		]);
		const snapshot = balances.map((b) => ({ ...b }));
		const ordered = orderByWhoShouldPay(balances);
		// Returns a NEW array (not the same reference) and leaves the original intact.
		expect(ordered).not.toBe(balances);
		expect(balances).toEqual(snapshot);
		expect(ordered).toEqual([
			{ memberId: 'm2', balance: -5000 },
			{ memberId: 'm1', balance: 5000 }
		]);
	});

	it('all-zero balances → stable order by memberId ascending', () => {
		const balances: MemberBalance[] = [
			{ memberId: 'm3', balance: 0 },
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: 0 }
		];
		expect(orderByWhoShouldPay(balances).map((b) => b.memberId)).toEqual(['m1', 'm2', 'm3']);
	});

	it('keeps integer minor units intact — no floats introduced', () => {
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 1 },
			{ memberId: 'm2', balance: -1 },
			{ memberId: 'm3', balance: 0 }
		];
		const ordered = orderByWhoShouldPay(balances);
		for (const { balance } of ordered) {
			expect(Number.isInteger(balance)).toBe(true);
		}
		expect(ordered).toEqual([
			{ memberId: 'm2', balance: -1 },
			{ memberId: 'm3', balance: 0 },
			{ memberId: 'm1', balance: 1 }
		]);
	});

	it('empty input → empty array', () => {
		expect(orderByWhoShouldPay([])).toEqual([]);
	});
});
