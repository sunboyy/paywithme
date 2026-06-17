import { describe, it, expect } from 'vitest';
import { resolveShares, resolveItemizedShares, type ResolveSharesInput } from './resolve';
import {
	buildTransactionSchema,
	type TransactionInput,
	type ItemInput
} from '$lib/schemas/transaction';

// Unit tests for the non-itemized split resolver (PLAN §7.2 — task 4.5).
//
// They prove, for split_mode ∈ { equal, amount, share }:
//   - even AND uneven divisions resolve correctly, with the remainder distributed
//     by the largest-remainder + ascending-`member_id` tie-break (asserted with a
//     deterministic expected assignment, and the tie-break proven EXPLICITLY);
//   - share weights (integer and rounding-forcing) resolve via `distribute`;
//   - `amount` mode is a pure passthrough of each `raw_amount`;
//   - a 0-dp currency (JPY) and a 2-dp currency (THB) exercise exponent handling
//     through `distribute` (resolution is in MINOR units, so exponent is implicit
//     in the totals — both are checked);
//   - the single-beneficiary case;
//   - the SUM-EQUALS-amount_total invariant across every case (plus a property
//     sweep over many random equal/share inputs);
//   - results come back in input order.
//
// Inputs are taken from REAL schema-validated payloads where practical (via
// `buildTransactionSchema`) so the resolver and the 4.4 schema stay aligned.

const thbSchema = buildTransactionSchema({ settlementCurrency: 'THB' });

/**
 * Parse a payload through the real transaction schema and return the narrowed
 * resolver input — so every "validated" case is genuinely schema-valid, not a
 * hand-built shape that could drift from §7.4.
 */
function validResolveInput(payload: Record<string, unknown>): ResolveSharesInput {
	const parsed = thbSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`fixture is not schema-valid: ${JSON.stringify(parsed.error.issues)}`);
	}
	const tx = parsed.data as TransactionInput;
	return {
		splitMode: tx.splitMode as ResolveSharesInput['splitMode'],
		amountTotal: tx.amountTotal,
		beneficiaries: tx.beneficiaries
	};
}

/** A minimal valid same-currency (THB) spending; tests override what they probe. */
function baseSpending(overrides: Record<string, unknown> = {}) {
	const merged = {
		type: 'spending',
		title: 'Dinner',
		categoryId: 'spending-food-drink',
		amountTotal: 9000,
		currency: 'THB',
		exchangeRate: '1',
		splitMode: 'equal',
		payers: [{ memberId: 'm1', amountPaid: 9000 }],
		beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }],
		items: [],
		charges: [],
		...overrides
	};
	// exchangeRate is '1' here, so the settlement total tracks amountTotal unless a
	// test explicitly overrides it (keeps fixtures §7.4-valid when amountTotal changes).
	return { amountTotalSettlement: merged.amountTotal, ...merged };
}

/** Sum of resolved owed amounts — the invariant probe (§7.4: Σ owed == amount_total). */
function sumOwed(shares: { amountOwed: number }[]): number {
	return shares.reduce((acc, s) => acc + s.amountOwed, 0);
}

describe('resolveShares — equal split', () => {
	it('splits an evenly-divisible total equally (validated input)', () => {
		// ฿90.00 across 3 → 3000 each.
		const input = validResolveInput(baseSpending({ amountTotal: 9000 }));
		const result = resolveShares(input);
		expect(result).toEqual([
			{ memberId: 'm1', amountOwed: 3000 },
			{ memberId: 'm2', amountOwed: 3000 },
			{ memberId: 'm3', amountOwed: 3000 }
		]);
		expect(sumOwed(result)).toBe(9000);
	});

	it('distributes the remainder to the lowest member_ids (ascending) when it does not divide', () => {
		// 100 minor units across 3 → 34 / 33 / 33: the +1 goes to the lowest id (m1).
		const input = validResolveInput(
			baseSpending({
				amountTotal: 100,
				payers: [{ memberId: 'm1', amountPaid: 100 }],
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
			})
		);
		const result = resolveShares(input);
		expect(result).toEqual([
			{ memberId: 'm1', amountOwed: 34 },
			{ memberId: 'm2', amountOwed: 33 },
			{ memberId: 'm3', amountOwed: 33 }
		]);
		expect(sumOwed(result)).toBe(100);
	});

	it('proves the ascending tie-break EXPLICITLY: equal remainders → lower ids win the leftover', () => {
		// 4 minor units across 3 equal shares → base 1 each, leftover 1, all remainders
		// equal → the single extra unit goes to the LOWEST id. Order the input so the
		// lowest id is NOT first, proving the assignment is by id, not position.
		const result = resolveShares({
			splitMode: 'equal',
			amountTotal: 4,
			beneficiaries: [{ memberId: 'm3' }, { memberId: 'm1' }, { memberId: 'm2' }]
		});
		// Returned in INPUT order; m1 (lowest id) carries the extra unit.
		expect(result).toEqual([
			{ memberId: 'm3', amountOwed: 1 },
			{ memberId: 'm1', amountOwed: 2 },
			{ memberId: 'm2', amountOwed: 1 }
		]);
		expect(sumOwed(result)).toBe(4);
	});

	it('handles a single beneficiary (owes the whole total)', () => {
		const result = resolveShares({
			splitMode: 'equal',
			amountTotal: 7777,
			beneficiaries: [{ memberId: 'm1' }]
		});
		expect(result).toEqual([{ memberId: 'm1', amountOwed: 7777 }]);
	});

	it('resolves a 0-dp currency (JPY) total in minor units', () => {
		// JPY is 0-dp, so ¥1000 == 1000 minor units; /3 → 334 / 333 / 333.
		const result = resolveShares({
			splitMode: 'equal',
			amountTotal: 1000,
			beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
		});
		expect(result.map((r) => r.amountOwed)).toEqual([334, 333, 333]);
		expect(sumOwed(result)).toBe(1000);
	});

	it('resolves a 2-dp currency total (THB) in minor units', () => {
		// ฿10.00 == 1000 minor units across 3 → 334 / 333 / 333 (same minor arithmetic).
		const result = resolveShares({
			splitMode: 'equal',
			amountTotal: 1000,
			beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
		});
		expect(sumOwed(result)).toBe(1000);
	});
});

describe('resolveShares — share split', () => {
	it('resolves integer weights proportionally (validated input)', () => {
		// weights 2/0/1 over ฿90.00 → 6000 / 0 / 3000.
		const input = validResolveInput(
			baseSpending({
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 2 },
					{ memberId: 'm2', shareWeight: 0 },
					{ memberId: 'm3', shareWeight: 1 }
				]
			})
		);
		const result = resolveShares(input);
		expect(result).toEqual([
			{ memberId: 'm1', amountOwed: 6000 },
			{ memberId: 'm2', amountOwed: 0 },
			{ memberId: 'm3', amountOwed: 3000 }
		]);
		expect(sumOwed(result)).toBe(9000);
	});

	it('applies largest-remainder rounding when weights do not divide evenly', () => {
		// 100 minor units, weights 1/1/1 → exact 33.33 each; remainders equal → the
		// leftover unit goes to the lowest id (m1): 34 / 33 / 33.
		const result = resolveShares({
			splitMode: 'share',
			amountTotal: 100,
			beneficiaries: [
				{ memberId: 'm1', shareWeight: 1 },
				{ memberId: 'm2', shareWeight: 1 },
				{ memberId: 'm3', shareWeight: 1 }
			]
		});
		expect(result.map((r) => r.amountOwed)).toEqual([34, 33, 33]);
		expect(sumOwed(result)).toBe(100);
	});

	it('forces a largest-remainder decision with asymmetric weights', () => {
		// total 10, weights 1/2 → exact 3.33 / 6.66; remainders 1/3 and 2/3 → the
		// leftover unit goes to the LARGER remainder (m2): 3 / 7.
		const result = resolveShares({
			splitMode: 'share',
			amountTotal: 10,
			beneficiaries: [
				{ memberId: 'm1', shareWeight: 1 },
				{ memberId: 'm2', shareWeight: 2 }
			]
		});
		expect(result).toEqual([
			{ memberId: 'm1', amountOwed: 3 },
			{ memberId: 'm2', amountOwed: 7 }
		]);
		expect(sumOwed(result)).toBe(10);
	});

	it('handles a single beneficiary with any positive weight (owes the whole total)', () => {
		const result = resolveShares({
			splitMode: 'share',
			amountTotal: 5000,
			beneficiaries: [{ memberId: 'm1', shareWeight: 7 }]
		});
		expect(result).toEqual([{ memberId: 'm1', amountOwed: 5000 }]);
	});
});

describe('resolveShares — amount split', () => {
	it('passes each raw_amount through unchanged (validated input)', () => {
		const input = validResolveInput(
			baseSpending({
				splitMode: 'amount',
				beneficiaries: [
					{ memberId: 'm1', rawAmount: 5000 },
					{ memberId: 'm2', rawAmount: 4000 }
				]
			})
		);
		const result = resolveShares(input);
		expect(result).toEqual([
			{ memberId: 'm1', amountOwed: 5000 },
			{ memberId: 'm2', amountOwed: 4000 }
		]);
		expect(sumOwed(result)).toBe(9000); // Σ raw_amount == amount_total
	});

	it('throws if an amount-mode beneficiary is missing its raw_amount (contract guard)', () => {
		expect(() =>
			resolveShares({
				splitMode: 'amount',
				amountTotal: 5000,
				beneficiaries: [{ memberId: 'm1' }]
			})
		).toThrow(/raw_amount/);
	});
});

describe('resolveShares — guards & ordering', () => {
	it('throws on zero beneficiaries', () => {
		expect(() =>
			resolveShares({ splitMode: 'equal', amountTotal: 100, beneficiaries: [] })
		).toThrow(/zero beneficiaries/);
	});

	it('returns results in input order for every mode', () => {
		const order = ['m3', 'm1', 'm2'];
		const equal = resolveShares({
			splitMode: 'equal',
			amountTotal: 9,
			beneficiaries: order.map((memberId) => ({ memberId }))
		});
		expect(equal.map((r) => r.memberId)).toEqual(order);

		const share = resolveShares({
			splitMode: 'share',
			amountTotal: 9,
			beneficiaries: order.map((memberId) => ({ memberId, shareWeight: 1 }))
		});
		expect(share.map((r) => r.memberId)).toEqual(order);
	});
});

describe('resolveShares — sum-equals-amount_total invariant (property sweep)', () => {
	// Deterministic pseudo-random sweep: many equal & share inputs across a range of
	// totals and beneficiary counts — the resolved owed amounts must ALWAYS sum
	// exactly to amount_total (the §7.4 / §8 source-of-truth guarantee).
	function lcg(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (1664525 * state + 1013904223) >>> 0;
			return state / 0x100000000;
		};
	}

	it('Σ amountOwed == amountTotal for equal and share across a randomized sweep', () => {
		const rand = lcg(42);
		for (let i = 0; i < 500; i++) {
			const n = 1 + Math.floor(rand() * 8); // 1..8 beneficiaries
			const amountTotal = Math.floor(rand() * 1_000_000); // up to ฿10,000.00 minor
			const beneficiaries = Array.from({ length: n }, (_, k) => ({
				memberId: `m${k + 1}`
			}));

			const equal = resolveShares({ splitMode: 'equal', amountTotal, beneficiaries });
			expect(sumOwed(equal)).toBe(amountTotal);

			// Share: random non-negative weights, with ≥1 positive (schema requires Σ>0).
			const weights: number[] = beneficiaries.map(() => Math.floor(rand() * 5));
			if (weights.reduce((a, b) => a + b, 0) === 0) weights[0] = 1;
			const shareBenes = beneficiaries.map((b, k) => ({ ...b, shareWeight: weights[k] }));
			const share = resolveShares({ splitMode: 'share', amountTotal, beneficiaries: shareBenes });
			expect(sumOwed(share)).toBe(amountTotal);
		}
	});
});

// ── Itemized resolution (PLAN §7.2.1 / §7.2.3 — task 4.8). ──────────────────────
//
// Each item resolves via the SAME per-line equal/amount/share core, rounding
// WITHIN the item (so each item's shares sum to its amount), then aggregates per
// member. The whole aggregate sums exactly to items_subtotal (= amount_total, no
// charges in 4.8). Probed: per-item rounding, cross-item aggregation, a member in
// some items and not others, mixed per-item modes, the ascending tie-break within
// an item, 0-dp (JPY) + 2-dp (THB), single item/single beneficiary, and a sweep.

/**
 * Parse an itemized SPENDING payload through the real schema and return its
 * normalized `items` — so the itemized resolver tests run on genuinely §7.4-valid
 * items (≥1 item, item amount>0, ≥1 beneficiary, per-item split valid) and stay
 * aligned with the 4.4 schema. amount_total must equal Σ item.amount (no charges
 * in 4.8) for the payload to validate.
 */
function validItems(items: ItemInput[]): ItemInput[] {
	const subtotal = items.reduce((acc, it) => acc + it.amount, 0);
	const payload = baseSpending({
		splitMode: 'itemized',
		amountTotal: subtotal,
		amountTotalSettlement: subtotal,
		payers: [{ memberId: 'm1', amountPaid: subtotal }],
		// itemized: top-level beneficiaries live on items, none at the top.
		beneficiaries: [],
		items
	});
	const parsed = thbSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`itemized fixture is not schema-valid: ${JSON.stringify(parsed.error.issues)}`);
	}
	return (parsed.data as TransactionInput).items;
}

describe('resolveItemizedShares — per-item rounding + aggregation', () => {
	it('rounds WITHIN each item: every item share-set sums exactly to its amount', () => {
		// Two items that each don't divide evenly: 100 across 3 (equal) and 10 across
		// weights 1/2 (share). Each must sum to ITS OWN amount, independently.
		const items = validItems([
			{
				label: 'Pizza',
				amount: 100,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
			},
			{
				label: 'Wine',
				amount: 10,
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 1 },
					{ memberId: 'm2', shareWeight: 2 }
				]
			}
		]);
		const result = resolveItemizedShares(items);

		expect(sumOwed(result.items[0].shares)).toBe(100);
		expect(sumOwed(result.items[1].shares)).toBe(10);
		// Item 0: 34/33/33 (extra to lowest id m1). Item 1: 3/7 (larger remainder m2).
		expect(result.items[0].shares).toEqual([
			{ memberId: 'm1', amountOwed: 34 },
			{ memberId: 'm2', amountOwed: 33 },
			{ memberId: 'm3', amountOwed: 33 }
		]);
		expect(result.items[1].shares).toEqual([
			{ memberId: 'm1', amountOwed: 3 },
			{ memberId: 'm2', amountOwed: 7 }
		]);
	});

	it('aggregates per member across items; the whole resolution sums to items_subtotal', () => {
		const items = validItems([
			{
				label: 'Pizza',
				amount: 100,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
			},
			{
				label: 'Wine',
				amount: 10,
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 1 },
					{ memberId: 'm2', shareWeight: 2 }
				]
			}
		]);
		const result = resolveItemizedShares(items);

		// m1: 34 + 3 = 37; m2: 33 + 7 = 40; m3: 33 + 0 = 33. Sum = 110 = subtotal.
		expect(result.shares).toEqual([
			{ memberId: 'm1', amountOwed: 37 },
			{ memberId: 'm2', amountOwed: 40 },
			{ memberId: 'm3', amountOwed: 33 }
		]);
		expect(sumOwed(result.shares)).toBe(110);
	});

	it('a member in SOME items and not others owes only the items they are in', () => {
		// m3 only in the first item; m2 only in the second.
		const items = validItems([
			{
				label: 'Shared starter',
				amount: 90,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm3' }]
			},
			{
				label: 'Steak',
				amount: 40,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
			}
		]);
		const result = resolveItemizedShares(items);

		const byMember = Object.fromEntries(result.shares.map((s) => [s.memberId, s.amountOwed]));
		// item0: 45/45 to m1/m3; item1: 20/20 to m1/m2.
		expect(byMember.m1).toBe(65); // in both: 45 + 20
		expect(byMember.m2).toBe(20); // only item1
		expect(byMember.m3).toBe(45); // only item0
		expect(sumOwed(result.shares)).toBe(130);
	});

	it('mixes per-item split modes (equal / share / amount) and still sums exactly', () => {
		const items = validItems([
			{
				label: 'Equal item',
				amount: 99,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
			},
			{
				label: 'Share item',
				amount: 100,
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 3 },
					{ memberId: 'm2', shareWeight: 1 }
				]
			},
			{
				label: 'Amount item',
				amount: 70,
				splitMode: 'amount',
				beneficiaries: [
					{ memberId: 'm1', rawAmount: 30 },
					{ memberId: 'm2', rawAmount: 40 }
				]
			}
		]);
		const result = resolveItemizedShares(items);

		expect(sumOwed(result.items[0].shares)).toBe(99);
		expect(sumOwed(result.items[1].shares)).toBe(100);
		expect(sumOwed(result.items[2].shares)).toBe(70);
		// equal 99/2 → 50/49 (extra to m1); share 3:1 of 100 → 75/25; amount 30/40.
		const byMember = Object.fromEntries(result.shares.map((s) => [s.memberId, s.amountOwed]));
		expect(byMember.m1).toBe(50 + 75 + 30);
		expect(byMember.m2).toBe(49 + 25 + 40);
		expect(sumOwed(result.shares)).toBe(269);
	});

	it('proves the ascending member_id tie-break WITHIN an item', () => {
		// 4 minor units, 3 equal beneficiaries listed lowest-id-NOT-first; the single
		// leftover unit goes to the lowest id (m1), proving it is by id not position.
		const items = validItems([
			{
				label: 'Tie',
				amount: 4,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm3' }, { memberId: 'm1' }, { memberId: 'm2' }]
			}
		]);
		const result = resolveItemizedShares(items);
		expect(result.items[0].shares).toEqual([
			{ memberId: 'm3', amountOwed: 1 },
			{ memberId: 'm1', amountOwed: 2 },
			{ memberId: 'm2', amountOwed: 1 }
		]);
	});

	it('resolves a 0-dp currency (JPY) itemized split, summing exactly', () => {
		// JPY 0-dp: ¥1000 across 3 (equal) → 334/333/333; single item.
		const result = resolveItemizedShares([
			{
				label: 'Ramen',
				amount: 1000,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
			}
		]);
		expect(result.items[0].shares.map((s) => s.amountOwed)).toEqual([334, 333, 333]);
		expect(sumOwed(result.shares)).toBe(1000);
	});

	it('resolves a 2-dp currency (THB) itemized split, summing exactly', () => {
		// 1000 minor across 3 → 334/333/333, same minor arithmetic.
		const items = validItems([
			{
				label: 'Som tam',
				amount: 1000,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
			}
		]);
		const result = resolveItemizedShares(items);
		expect(sumOwed(result.shares)).toBe(1000);
	});

	it('handles a single item with a single beneficiary (owes the whole item)', () => {
		const items = validItems([
			{ label: 'Solo', amount: 5000, splitMode: 'equal', beneficiaries: [{ memberId: 'm1' }] }
		]);
		const result = resolveItemizedShares(items);
		expect(result.items[0].shares).toEqual([{ memberId: 'm1', amountOwed: 5000 }]);
		expect(result.shares).toEqual([{ memberId: 'm1', amountOwed: 5000 }]);
	});

	it('throws on zero items (schema requires at least one)', () => {
		expect(() => resolveItemizedShares([])).toThrow(/zero items/);
	});

	it('aggregated owed sums to items_subtotal across a randomized itemized sweep', () => {
		function lcg(seed: number): () => number {
			let state = seed >>> 0;
			return () => {
				state = (1664525 * state + 1013904223) >>> 0;
				return state / 0x100000000;
			};
		}
		const rand = lcg(7);
		for (let i = 0; i < 300; i++) {
			const itemCount = 1 + Math.floor(rand() * 5); // 1..5 items
			const items: ItemInput[] = Array.from({ length: itemCount }, () => {
				const n = 1 + Math.floor(rand() * 5); // 1..5 beneficiaries
				const amount = 1 + Math.floor(rand() * 50_000);
				const benes = Array.from({ length: n }, (_, k) => ({ memberId: `m${k + 1}` }));
				// Alternate equal / share to exercise both rounding paths.
				if (i % 2 === 0) {
					return { label: 'x', amount, splitMode: 'equal' as const, beneficiaries: benes };
				}
				const weights = benes.map(() => Math.floor(rand() * 4));
				if (weights.reduce((a, b) => a + b, 0) === 0) weights[0] = 1;
				return {
					label: 'x',
					amount,
					splitMode: 'share' as const,
					beneficiaries: benes.map((b, k) => ({ ...b, shareWeight: weights[k] }))
				};
			});
			const subtotal = items.reduce((acc, it) => acc + it.amount, 0);
			const result = resolveItemizedShares(items);
			// Each item sums to its own amount, and the aggregate sums to the subtotal.
			for (let k = 0; k < items.length; k++) {
				expect(sumOwed(result.items[k].shares)).toBe(items[k].amount);
			}
			expect(sumOwed(result.shares)).toBe(subtotal);
		}
	});
});
