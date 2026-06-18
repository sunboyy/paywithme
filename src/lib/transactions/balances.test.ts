import { describe, it, expect } from 'vitest';

// Unit tests for the PURE net-balance core (PLAN §8.1, task 5.1). No DB, no mocks —
// just the integer money math: balance(member) = Σ paid_settlement − Σ owed, with
// every member present (incl. zero-balance) and Σ of all balances == 0.

import {
	computeBalances,
	orderByWhoShouldPay,
	suggestSettlements,
	type MemberBalance,
	type SettlementSuggestion
} from './balances';

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

describe('suggestSettlements (PLAN §8.3 — simplified, minimize transfers)', () => {
	/**
	 * CONSERVATION helper (the heart of §8.3): start from the input balances, apply
	 * every suggested transfer — debtor (from) gains the amount toward 0, creditor
	 * (to) loses it toward 0 — and return the resulting per-member balance map. A
	 * correct suggestion set zeroes EVERY entry. Also enforces, per transfer, that:
	 *   - `from` was a debtor (negative) and `to` was a creditor (positive),
	 *   - amount is a positive integer, no self-transfer.
	 */
	function applyTransfers(
		balances: readonly MemberBalance[],
		suggestions: readonly SettlementSuggestion[]
	): Map<string, number> {
		const ledger = new Map(balances.map((b) => [b.memberId, b.balance]));
		const originalSign = new Map(balances.map((b) => [b.memberId, Math.sign(b.balance)]));
		for (const s of suggestions) {
			expect(s.amount).toBeGreaterThan(0);
			expect(Number.isInteger(s.amount)).toBe(true); // integer minor units, no floats
			expect(s.fromMemberId).not.toBe(s.toMemberId); // no self-transfers
			// `from` is always a debtor, `to` always a creditor (original signs).
			expect(originalSign.get(s.fromMemberId)).toBe(-1);
			expect(originalSign.get(s.toMemberId)).toBe(1);
			// The debtor pays (balance rises toward 0); the creditor is paid (falls toward 0).
			ledger.set(s.fromMemberId, (ledger.get(s.fromMemberId) ?? 0) + s.amount);
			ledger.set(s.toMemberId, (ledger.get(s.toMemberId) ?? 0) - s.amount);
		}
		return ledger;
	}

	/** Assert conservation: after applying all transfers, every balance is exactly 0. */
	function expectAllSquare(
		balances: readonly MemberBalance[],
		suggestions: readonly SettlementSuggestion[]
	): void {
		const ledger = applyTransfers(balances, suggestions);
		for (const [, bal] of ledger) {
			expect(bal).toBe(0);
		}
	}

	/** Minimality bound (§8.3): greedy yields ≤ (non-zero members − 1) transfers. */
	function nonZeroCount(balances: readonly MemberBalance[]): number {
		return balances.filter((b) => b.balance !== 0).length;
	}

	it('all balances zero → no suggestions (empty array)', () => {
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: 0 }
		];
		expect(suggestSettlements(balances)).toEqual([]);
	});

	it('empty input → empty array', () => {
		expect(suggestSettlements([])).toEqual([]);
	});

	it('single debtor ↔ single creditor exact match → exactly one transfer', () => {
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 5000 }, // creditor
			{ memberId: 'm2', balance: -5000 } // debtor
		];
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toEqual([{ fromMemberId: 'm2', toMemberId: 'm1', amount: 5000 }]);
		expect(suggestions.length).toBeLessThanOrEqual(nonZeroCount(balances) - 1);
		expectAllSquare(balances, suggestions);
	});

	it('1 debtor owes N creditors → debtor pays each, largest creditor first', () => {
		// m3 owes 9000; m1 is owed 6000, m2 is owed 3000. Largest creditor (m1) first.
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 6000 },
			{ memberId: 'm2', balance: 3000 },
			{ memberId: 'm3', balance: -9000 }
		];
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toEqual([
			{ fromMemberId: 'm3', toMemberId: 'm1', amount: 6000 },
			{ fromMemberId: 'm3', toMemberId: 'm2', amount: 3000 }
		]);
		expect(suggestions.length).toBeLessThanOrEqual(nonZeroCount(balances) - 1);
		expectAllSquare(balances, suggestions);
	});

	it('N debtors → 1 creditor (mirror) → each debtor pays the single creditor', () => {
		// m1 is owed 9000; m2 owes 6000, m3 owes 3000. Largest debtor (m2) pays first.
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 9000 },
			{ memberId: 'm2', balance: -6000 },
			{ memberId: 'm3', balance: -3000 }
		];
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toEqual([
			{ fromMemberId: 'm2', toMemberId: 'm1', amount: 6000 },
			{ fromMemberId: 'm3', toMemberId: 'm1', amount: 3000 }
		]);
		expect(suggestions.length).toBeLessThanOrEqual(nonZeroCount(balances) - 1);
		expectAllSquare(balances, suggestions);
	});

	it('chain A→B→C collapses: naive 2 pairwise debts simplify to 1 transfer', () => {
		// Net balances of a chain where A owes B and B owes C the same 5000: B nets to
		// 0 and drops out entirely — the simplified set is the single A→C transfer,
		// FEWER than the two naive pairwise debts.
		const balances: MemberBalance[] = [
			{ memberId: 'mA', balance: -5000 }, // A owes
			{ memberId: 'mB', balance: 0 }, // B passes through → ignored
			{ memberId: 'mC', balance: 5000 } // C is owed
		];
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toEqual([{ fromMemberId: 'mA', toMemberId: 'mC', amount: 5000 }]);
		// One transfer < two naive pairwise debts; ≤ nonzero−1 (= 1).
		expect(suggestions).toHaveLength(1);
		expect(suggestions.length).toBeLessThanOrEqual(nonZeroCount(balances) - 1);
		expectAllSquare(balances, suggestions);
	});

	it('unequal magnitudes: larger party carries a residual into the next match', () => {
		// m3 owes 8000 (largest debtor). Creditors: m1 +5000 (largest), m2 +3000.
		// Step 1: m3→m1 min(8000,5000)=5000; m3 residual 3000 carries forward.
		// Step 2: m3→m2 min(3000,3000)=3000 → all square.
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 5000 },
			{ memberId: 'm2', balance: 3000 },
			{ memberId: 'm3', balance: -8000 }
		];
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toEqual([
			{ fromMemberId: 'm3', toMemberId: 'm1', amount: 5000 },
			{ fromMemberId: 'm3', toMemberId: 'm2', amount: 3000 }
		]);
		expect(suggestions.length).toBeLessThanOrEqual(nonZeroCount(balances) - 1);
		expectAllSquare(balances, suggestions);
	});

	it('debtor residual on the OTHER side: creditor partially settled, carries on', () => {
		// Largest creditor m1 +9000; debtors m2 −5000 (largest), m3 −4000.
		// Step 1: m2→m1 5000 → m2 done, m1 residual 4000.
		// Step 2: m3→m1 4000 → all square.
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 9000 },
			{ memberId: 'm2', balance: -5000 },
			{ memberId: 'm3', balance: -4000 }
		];
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toEqual([
			{ fromMemberId: 'm2', toMemberId: 'm1', amount: 5000 },
			{ fromMemberId: 'm3', toMemberId: 'm1', amount: 4000 }
		]);
		expectAllSquare(balances, suggestions);
	});

	it('ignores zero-balance members entirely (never appears in a suggestion)', () => {
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 5000 },
			{ memberId: 'm2', balance: -5000 },
			{ memberId: 'm3', balance: 0 } // square — must not show up
		];
		const suggestions = suggestSettlements(balances);
		const touched = new Set(suggestions.flatMap((s) => [s.fromMemberId, s.toMemberId]));
		expect(touched.has('m3')).toBe(false);
		expectAllSquare(balances, suggestions);
	});

	it('determinism: equal magnitudes break ties by memberId ascending', () => {
		// Two debtors of equal size (mb, mc) and two creditors of equal size (ma, md).
		// Tie-break ascending: largest debtor picks 'mb' before 'mc'; largest creditor
		// picks 'ma' before 'md'. So mb→ma, then mc→md.
		const balances: MemberBalance[] = [
			{ memberId: 'ma', balance: 4000 },
			{ memberId: 'mb', balance: -4000 },
			{ memberId: 'mc', balance: -4000 },
			{ memberId: 'md', balance: 4000 }
		];
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toEqual([
			{ fromMemberId: 'mb', toMemberId: 'ma', amount: 4000 },
			{ fromMemberId: 'mc', toMemberId: 'md', amount: 4000 }
		]);
		expectAllSquare(balances, suggestions);
	});

	it('determinism: scrambled input order yields an IDENTICAL suggestion list', () => {
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 7000 },
			{ memberId: 'm2', balance: -3000 },
			{ memberId: 'm3', balance: 2000 },
			{ memberId: 'm4', balance: -6000 }
		];
		const first = suggestSettlements(balances);
		// Reversed, then a different shuffle — all must produce the same output.
		const second = suggestSettlements([...balances].reverse());
		const third = suggestSettlements([balances[2], balances[0], balances[3], balances[1]]);
		expect(second).toEqual(first);
		expect(third).toEqual(first);
		expectAllSquare(balances, first);
	});

	it('does NOT mutate the input array (frozen input is safe)', () => {
		const balances: readonly MemberBalance[] = Object.freeze([
			Object.freeze({ memberId: 'm1', balance: 5000 }),
			Object.freeze({ memberId: 'm2', balance: -5000 })
		]);
		const snapshot = balances.map((b) => ({ ...b }));
		suggestSettlements(balances);
		expect(balances).toEqual(snapshot);
	});

	it('larger mixed set: conservation holds AND transfers ≤ nonzero−1', () => {
		// 6 members, mixed creditors/debtors, sums to 0; one is square (ignored).
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 10000 },
			{ memberId: 'm2', balance: -4500 },
			{ memberId: 'm3', balance: 3000 },
			{ memberId: 'm4', balance: -8500 },
			{ memberId: 'm5', balance: 0 },
			{ memberId: 'm6', balance: 0 }
		];
		// sanity: input nets to zero (precondition of §8.1).
		expect(totalBalance(balances)).toBe(0);
		const suggestions = suggestSettlements(balances);
		expectAllSquare(balances, suggestions);
		expect(suggestions.length).toBeLessThanOrEqual(nonZeroCount(balances) - 1);
	});

	it('all amounts are positive integers (minor units) — no floats', () => {
		const balances: MemberBalance[] = [
			{ memberId: 'm1', balance: 3334 },
			{ memberId: 'm2', balance: -1 },
			{ memberId: 'm3', balance: -3333 }
		];
		const suggestions = suggestSettlements(balances);
		for (const s of suggestions) {
			expect(Number.isInteger(s.amount)).toBe(true);
			expect(s.amount).toBeGreaterThan(0);
		}
		expectAllSquare(balances, suggestions);
	});
});
