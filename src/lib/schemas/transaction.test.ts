import { describe, it, expect } from 'vitest';
import {
	buildTransactionSchema,
	applyCharges,
	convertToSettlement,
	MAX_PERCENT_BPS,
	type ChargeInput
} from './transaction';

// Unit tests for the shared transaction create/edit input schema (PLAN §7.4, with
// the §7.2.2 charge model and §7.6 FX conversion). Everything here is INPUT-level:
// structural + cross-field math in transaction-currency minor units. Split
// RESOLUTION (4.5) and the settlement-side tie-out (4.10) are out of scope and
// intentionally untested here.
//
// Currencies: THB/USD = 2-dp, JPY = 0-dp — chosen so the exponent-driven
// conversion/rounding is exercised against real currency precision.

// A THB-settled group is the default context for most cases.
const thbSchema = buildTransactionSchema({ settlementCurrency: 'THB' });

/** A minimal valid same-currency (THB) spending; tests override what they probe. */
function baseSpending(overrides: Record<string, unknown> = {}) {
	return {
		type: 'spending',
		title: 'Dinner',
		categoryId: 'spending-food-drink',
		amountTotal: 9000, // ฿90.00
		currency: 'THB',
		exchangeRate: '1',
		amountTotalSettlement: 9000,
		splitMode: 'equal',
		payers: [{ memberId: 'm1', amountPaid: 9000 }],
		beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }],
		items: [],
		charges: [],
		...overrides
	};
}

describe('buildTransactionSchema — valid cases', () => {
	it('accepts a valid equal-split spending', () => {
		expect(thbSchema.safeParse(baseSpending()).success).toBe(true);
	});

	it('accepts a valid amount-split spending where Σ raw_amount == amount_total', () => {
		const parsed = thbSchema.safeParse(
			baseSpending({
				splitMode: 'amount',
				beneficiaries: [
					{ memberId: 'm1', rawAmount: 5000 },
					{ memberId: 'm2', rawAmount: 4000 }
				]
			})
		);
		expect(parsed.success).toBe(true);
	});

	it('accepts a valid share-split spending with Σ weight > 0', () => {
		const parsed = thbSchema.safeParse(
			baseSpending({
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 2 },
					{ memberId: 'm2', shareWeight: 0 },
					{ memberId: 'm3', shareWeight: 1 }
				]
			})
		);
		expect(parsed.success).toBe(true);
	});

	it('accepts a valid transfer (amount split)', () => {
		const parsed = thbSchema.safeParse({
			type: 'transfer',
			title: 'Settle up',
			categoryId: 'transfer-debt-settlement',
			amountTotal: 5000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 5000,
			splitMode: 'amount',
			payers: [{ memberId: 'm1', amountPaid: 5000 }],
			beneficiaries: [{ memberId: 'm2', rawAmount: 5000 }],
			items: [],
			charges: []
		});
		expect(parsed.success).toBe(true);
	});
});

describe('buildTransactionSchema — structural rules (§7.4)', () => {
	it('rejects zero payers', () => {
		const res = thbSchema.safeParse(baseSpending({ payers: [] }));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('payers'))).toBe(true);
		}
	});

	it('rejects zero beneficiaries', () => {
		const res = thbSchema.safeParse(baseSpending({ beneficiaries: [] }));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('beneficiaries'))).toBe(true);
		}
	});

	it('rejects Σ amount_paid != amount_total', () => {
		const res = thbSchema.safeParse(
			baseSpending({ payers: [{ memberId: 'm1', amountPaid: 8000 }] })
		);
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('payers'))).toBe(true);
		}
	});

	it('rejects a zero-total equal split (non-itemized must be > 0)', () => {
		const parsed = thbSchema.safeParse(
			baseSpending({
				amountTotal: 0,
				amountTotalSettlement: 0,
				payers: [{ memberId: 'm1', amountPaid: 0 }]
			})
		);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(
				parsed.error.issues.some(
					(i) =>
						i.path.includes('amountTotal') &&
						i.message === 'The transaction total must be greater than zero'
				)
			).toBe(true);
		}
	});

	it('still accepts a normal positive total (zero-amount guard is not too strict)', () => {
		expect(thbSchema.safeParse(baseSpending()).success).toBe(true);
	});

	it('rejects a zero-total transfer (non-itemized must be > 0)', () => {
		const parsed = thbSchema.safeParse({
			type: 'transfer',
			title: 'Settle up',
			categoryId: 'transfer-cash',
			amountTotal: 0,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 0,
			splitMode: 'equal',
			payers: [{ memberId: 'm1', amountPaid: 0 }],
			beneficiaries: [{ memberId: 'm2' }],
			items: [],
			charges: []
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(
				parsed.error.issues.some(
					(i) =>
						i.path.includes('amountTotal') &&
						i.message === 'The transaction total must be greater than zero'
				)
			).toBe(true);
		}
	});

	it('rejects a category whose applies_to does not match the type', () => {
		// transfer category on a spending transaction.
		const res = thbSchema.safeParse(baseSpending({ categoryId: 'transfer-cash' }));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('categoryId'))).toBe(true);
		}
	});

	it('rejects an unknown category id', () => {
		expect(thbSchema.safeParse(baseSpending({ categoryId: 'spending-nope' })).success).toBe(false);
	});

	it('rejects an itemized transfer (§7.2.3)', () => {
		const res = thbSchema.safeParse({
			type: 'transfer',
			title: 'Nope',
			categoryId: 'transfer-cash',
			amountTotal: 1000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 1000,
			splitMode: 'itemized',
			payers: [{ memberId: 'm1', amountPaid: 1000 }],
			beneficiaries: [],
			items: [
				{
					label: 'x',
					amount: 1000,
					splitMode: 'equal',
					beneficiaries: [{ memberId: 'm2' }]
				}
			],
			charges: []
		});
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('splitMode'))).toBe(true);
		}
	});
});

describe('buildTransactionSchema — non-itemized split rules (§7.4)', () => {
	it('rejects amount-mode where Σ raw_amount != amount_total', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				splitMode: 'amount',
				beneficiaries: [
					{ memberId: 'm1', rawAmount: 5000 },
					{ memberId: 'm2', rawAmount: 3000 } // 8000 != 9000
				]
			})
		);
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('beneficiaries'))).toBe(true);
		}
	});

	it('rejects share-mode with all-zero weights', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 0 },
					{ memberId: 'm2', shareWeight: 0 }
				]
			})
		);
		expect(res.success).toBe(false);
	});

	it('rejects a negative share weight', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				splitMode: 'share',
				beneficiaries: [{ memberId: 'm1', shareWeight: -1 }]
			})
		);
		expect(res.success).toBe(false);
	});
});

describe('buildTransactionSchema — itemized rules (§7.4 / §7.2.1)', () => {
	/** A valid itemized spending: two items, no charges, total == subtotal. */
	function baseItemized(overrides: Record<string, unknown> = {}) {
		return baseSpending({
			splitMode: 'itemized',
			amountTotal: 9000,
			amountTotalSettlement: 9000,
			beneficiaries: [],
			items: [
				{
					label: 'Pizza',
					amount: 6000,
					splitMode: 'equal',
					beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
				},
				{
					label: 'Beer',
					amount: 3000,
					splitMode: 'equal',
					beneficiaries: [{ memberId: 'm1' }]
				}
			],
			charges: [],
			...overrides
		});
	}

	it('accepts a valid itemized spending (total == items subtotal)', () => {
		expect(thbSchema.safeParse(baseItemized()).success).toBe(true);
	});

	it('rejects itemized with no items', () => {
		const res = thbSchema.safeParse(baseItemized({ items: [] }));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('items'))).toBe(true);
		}
	});

	it('rejects an item with a zero or negative amount', () => {
		expect(
			thbSchema.safeParse(
				baseItemized({
					amountTotal: 3000,
					amountTotalSettlement: 3000,
					items: [
						{ label: 'Free', amount: 0, splitMode: 'equal', beneficiaries: [{ memberId: 'm1' }] },
						{ label: 'Beer', amount: 3000, splitMode: 'equal', beneficiaries: [{ memberId: 'm1' }] }
					]
				})
			).success
		).toBe(false);
	});

	it('rejects an item with no beneficiaries', () => {
		const res = thbSchema.safeParse(
			baseItemized({
				amountTotal: 3000,
				amountTotalSettlement: 3000,
				items: [{ label: 'Beer', amount: 3000, splitMode: 'equal', beneficiaries: [] }]
			})
		);
		expect(res.success).toBe(false);
	});

	it("rejects an item whose own amount split doesn't add up", () => {
		const res = thbSchema.safeParse(
			baseItemized({
				amountTotal: 3000,
				amountTotalSettlement: 3000,
				items: [
					{
						label: 'Beer',
						amount: 3000,
						splitMode: 'amount',
						beneficiaries: [
							{ memberId: 'm1', rawAmount: 1000 },
							{ memberId: 'm2', rawAmount: 1000 } // 2000 != 3000
						]
					}
				]
			})
		);
		expect(res.success).toBe(false);
	});

	it('rejects amount_total != items_subtotal when there are no charges', () => {
		const res = thbSchema.safeParse(
			baseItemized({ amountTotal: 8000, amountTotalSettlement: 8000 })
		);
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('amountTotal'))).toBe(true);
		}
	});
});

describe('buildTransactionSchema — charge value bounds (§7.2.2 / §7.4)', () => {
	it('rejects a percent charge above 10000 bps', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				splitMode: 'itemized',
				beneficiaries: [],
				amountTotal: 6000,
				amountTotalSettlement: 6000,
				items: [
					{ label: 'Food', amount: 6000, splitMode: 'equal', beneficiaries: [{ memberId: 'm1' }] }
				],
				charges: [
					{
						kind: 'vat',
						mode: 'percent',
						value: MAX_PERCENT_BPS + 1,
						base: 'items_subtotal',
						sortOrder: 0
					}
				]
			})
		);
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('value'))).toBe(true);
		}
	});

	it('rejects a negative charge value (value is a non-negative magnitude)', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				splitMode: 'itemized',
				beneficiaries: [],
				amountTotal: 6000,
				amountTotalSettlement: 6000,
				items: [
					{ label: 'Food', amount: 6000, splitMode: 'equal', beneficiaries: [{ memberId: 'm1' }] }
				],
				charges: [
					{ kind: 'discount', mode: 'absolute', value: -100, base: 'running_total', sortOrder: 0 }
				]
			})
		);
		expect(res.success).toBe(false);
	});
});

describe('buildTransactionSchema — discount must not exceed base / total >= 0 (§7.4)', () => {
	it('rejects an absolute discount that exceeds its base', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				splitMode: 'itemized',
				beneficiaries: [],
				amountTotal: 0,
				amountTotalSettlement: 0,
				items: [
					{ label: 'Food', amount: 1000, splitMode: 'equal', beneficiaries: [{ memberId: 'm1' }] }
				],
				charges: [
					// 2000 discount on a 1000 running total → exceeds base AND total < 0.
					{ kind: 'discount', mode: 'absolute', value: 2000, base: 'running_total', sortOrder: 0 }
				]
			})
		);
		expect(res.success).toBe(false);
		if (!res.success) {
			const paths = res.error.issues.flatMap((i) => i.path);
			// Both the "exceeds base" (charges) and "total < 0" (amountTotal) refinements fire,
			// and the amountTotal equality (0 vs -1000) also fails — assert at least one is present.
			expect(paths.includes('charges') || paths.includes('amountTotal')).toBe(true);
		}
	});

	it('accepts a 100%-off discount that drives amount_total to exactly 0', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				splitMode: 'itemized',
				beneficiaries: [],
				amountTotal: 0,
				amountTotalSettlement: 0,
				payers: [{ memberId: 'm1', amountPaid: 0 }],
				items: [
					{ label: 'Food', amount: 1000, splitMode: 'equal', beneficiaries: [{ memberId: 'm1' }] }
				],
				charges: [
					{
						kind: 'discount',
						mode: 'percent',
						value: MAX_PERCENT_BPS, // 100%
						base: 'items_subtotal',
						sortOrder: 0
					}
				]
			})
		);
		expect(res.success).toBe(true);
	});
});

describe('applyCharges — §7.2.2 worked examples (integer round-half-up)', () => {
	// items_subtotal = 10000 (฿100.00).
	const SUBTOTAL = 10000;

	it('discount BEFORE tax: 10% off, then 10% service, then 7% VAT (all on running_total)', () => {
		// discount = round(10000 × 1000/10000) = 1000  → running 9000
		// service  = round(9000  × 1000/10000) = 900   → running 9900
		// vat      = round(9900  × 700/10000)  = 693   → running 10593
		const charges: ChargeInput[] = [
			{ kind: 'discount', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'service', mode: 'percent', value: 1000, base: 'running_total', sortOrder: 1 },
			{ kind: 'vat', mode: 'percent', value: 700, base: 'running_total', sortOrder: 2 }
		];
		const { amountTotal, discountExceedsBase } = applyCharges(SUBTOTAL, charges);
		expect(amountTotal).toBe(10593);
		expect(discountExceedsBase).toBe(false);
	});

	it('discount AFTER tax: 10% service, 7% VAT, then a flat 100 (10000 minor? no — 1000) coupon', () => {
		// service = round(10000 × 1000/10000) = 1000 → running 11000
		// vat     = round(11000 × 700/10000)  = 770  → running 11770
		// discount (absolute 1000) on running_total → running 10770
		const charges: ChargeInput[] = [
			{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'vat', mode: 'percent', value: 700, base: 'running_total', sortOrder: 1 },
			{ kind: 'discount', mode: 'absolute', value: 1000, base: 'running_total', sortOrder: 2 }
		];
		const { amountTotal } = applyCharges(SUBTOTAL, charges);
		expect(amountTotal).toBe(10770);
	});

	it('applies charges in sort_order regardless of array order', () => {
		const ordered: ChargeInput[] = [
			{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'vat', mode: 'percent', value: 700, base: 'running_total', sortOrder: 1 }
		];
		const shuffled = [ordered[1], ordered[0]];
		expect(applyCharges(SUBTOTAL, shuffled).amountTotal).toBe(
			applyCharges(SUBTOTAL, ordered).amountTotal
		);
	});

	it('rounds a percent charge half-up at the .5 tie (333.5 on a 50.00 base at 6.67%)', () => {
		// 5000 × 667 = 3,335,000; / 10000 = 333.5 → ties round UP → 334. running 5000 + 334 = 5334.
		const charges: ChargeInput[] = [
			{ kind: 'vat', mode: 'percent', value: 667, base: 'items_subtotal', sortOrder: 0 }
		];
		expect(applyCharges(5000, charges).amountTotal).toBe(5334);
	});

	it('rounds a percent charge DOWN below the .5 boundary', () => {
		// bps are integers, so pick a base that yields a fractional part < .5:
		// 3001 × 1 / 10000 = 0.3001 → rounds DOWN to 0. running 3001 + 0 = 3001.
		const charges: ChargeInput[] = [
			{ kind: 'vat', mode: 'percent', value: 1, base: 'items_subtotal', sortOrder: 0 }
		];
		expect(applyCharges(3001, charges).amountTotal).toBe(3001);
	});

	it('does not silently overflow on a large percent base (BigInt path, §7.2.2)', () => {
		// base × 10000 = 8e11 × 10000 = 8e15 > Number.MAX_SAFE_INTEGER (~9.007e15 limit
		// at base ~9e11) — the OLD `number` multiply would lose precision here.
		// 800_000_000_000 × 700 / 10000 = 56_000_000_000 (7% of an 8e11-minor bill).
		const base = 800_000_000_000;
		const charges: ChargeInput[] = [
			{ kind: 'vat', mode: 'percent', value: 700, base: 'items_subtotal', sortOrder: 0 }
		];
		expect(applyCharges(base, charges).amountTotal).toBe(base + 56_000_000_000);
	});
});

describe('applyCharges — per-charge signed effects (task 4.9, additive return field)', () => {
	const SUBTOTAL = 10000; // ฿100.00

	it('returns each charge SIGNED effect in sort_order for discount-BEFORE-tax', () => {
		// discount −1000, service +900, vat +693 (= the worked example above). The
		// per-charge effects must match those running-total deltas, in application order.
		const charges: ChargeInput[] = [
			{ kind: 'discount', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'service', mode: 'percent', value: 1000, base: 'running_total', sortOrder: 1 },
			{ kind: 'vat', mode: 'percent', value: 700, base: 'running_total', sortOrder: 2 }
		];
		const { amountTotal, perCharge } = applyCharges(SUBTOTAL, charges);
		expect(perCharge.map((p) => p.signedEffect)).toEqual([-1000, 900, 693]);
		// Σ signed effects + subtotal == amountTotal (the additive-field invariant).
		expect(perCharge.reduce((acc, p) => acc + p.signedEffect, SUBTOTAL)).toBe(amountTotal);
		expect(amountTotal).toBe(10593);
		// Each effect echoes its originating charge (for persistence/labelling).
		expect(perCharge.map((p) => p.charge.kind)).toEqual(['discount', 'service', 'vat']);
	});

	it('returns each charge SIGNED effect in sort_order for discount-AFTER-tax (absolute coupon)', () => {
		// service +1000, vat +770, discount −1000 (absolute, on running_total).
		const charges: ChargeInput[] = [
			{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'vat', mode: 'percent', value: 700, base: 'running_total', sortOrder: 1 },
			{ kind: 'discount', mode: 'absolute', value: 1000, base: 'running_total', sortOrder: 2 }
		];
		const { amountTotal, perCharge } = applyCharges(SUBTOTAL, charges);
		expect(perCharge.map((p) => p.signedEffect)).toEqual([1000, 770, -1000]);
		expect(perCharge.reduce((acc, p) => acc + p.signedEffect, SUBTOTAL)).toBe(amountTotal);
		expect(amountTotal).toBe(10770);
	});

	it('orders perCharge by sort_order regardless of array order', () => {
		const charges: ChargeInput[] = [
			{ kind: 'vat', mode: 'percent', value: 700, base: 'running_total', sortOrder: 1 },
			{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 }
		];
		const { perCharge } = applyCharges(SUBTOTAL, charges);
		expect(perCharge.map((p) => p.charge.sortOrder)).toEqual([0, 1]);
	});

	it('empty charges → empty perCharge and amountTotal == subtotal', () => {
		const { amountTotal, perCharge } = applyCharges(SUBTOTAL, []);
		expect(perCharge).toEqual([]);
		expect(amountTotal).toBe(SUBTOTAL);
	});
});

describe('convertToSettlement — §7.6 conversion (integer round-half-up)', () => {
	it('same exponent (CNY→THB, rate 4.85): ¥200.00 → ฿970.00', () => {
		expect(convertToSettlement(20000, 'CNY', 'THB', '4.85')).toBe(97000);
	});

	it('settlement is 0-dp (CNY→JPY, rate 21.5): ¥200.00 → ¥4300', () => {
		expect(convertToSettlement(20000, 'CNY', 'JPY', '21.5')).toBe(4300);
	});

	it('txn is 0-dp (JPY→THB, rate 0.22): ¥1000 → ฿220.00', () => {
		expect(convertToSettlement(1000, 'JPY', 'THB', '0.22')).toBe(22000);
	});

	it('rounds half-up: 0.01 USD at rate 2.5 → 2.5 THB minor → 3', () => {
		// 1 × 2500000 × 100 / (100 × 1000000) = 2.5 → 3
		expect(convertToSettlement(1, 'USD', 'THB', '2.5')).toBe(3);
	});

	it('identity at rate 1 when currencies match exponent', () => {
		expect(convertToSettlement(9000, 'THB', 'THB', '1')).toBe(9000);
	});

	it('does not silently overflow on a large amount (BigInt path, §7.6)', () => {
		// CNY→THB @4.85 on ¥500,000.00 = 50,000,000 minor units (well above the
		// ~¥185,715 threshold where the OLD `number` numerator overflowed).
		// numerator (old, number) = 50_000_000 × 4_850_000 × 100 = 2.425e16
		//   > Number.MAX_SAFE_INTEGER (~9.007e15) → silent precision loss.
		// Correct (BigInt): 50_000_000 × 4.85 = 242_500_000 ฿ minor units (฿2,425,000.00).
		expect(convertToSettlement(50_000_000, 'CNY', 'THB', '4.85')).toBe(242_500_000);
	});

	it('throws (does not silently truncate) if the settlement result exceeds the safe range', () => {
		// A result past MAX_SAFE_INTEGER must surface as an error, never a wrong number.
		expect(() => convertToSettlement(Number.MAX_SAFE_INTEGER, 'THB', 'THB', '1000')).toThrow();
	});
});

describe('buildTransactionSchema — FX rules (§7.6 / §7.4)', () => {
	it('rejects an unsupported currency', () => {
		expect(thbSchema.safeParse(baseSpending({ currency: 'BTC' })).success).toBe(false);
		expect(thbSchema.safeParse(baseSpending({ currency: 'usd' })).success).toBe(false);
	});

	it('requires rate == 1 when currency == settlement (rejects rate != 1)', () => {
		const res = thbSchema.safeParse(baseSpending({ exchangeRate: '4.85' }));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('exchangeRate'))).toBe(true);
		}
	});

	it('rejects a foreign currency with rate 0 or negative shape', () => {
		// rate '0' fails the > 0 field rule.
		expect(
			thbSchema.safeParse(
				baseSpending({ currency: 'CNY', exchangeRate: '0', amountTotalSettlement: 0 })
			).success
		).toBe(false);
		// a negative rate is not even a valid numeric(18,6) shape.
		expect(thbSchema.safeParse(baseSpending({ currency: 'CNY', exchangeRate: '-1' })).success).toBe(
			false
		);
	});

	it('accepts a foreign currency with a correct amount_total_settlement', () => {
		// ¥200.00 CNY at 4.85 → ฿970.00 = 97000.
		const res = thbSchema.safeParse(
			baseSpending({
				currency: 'CNY',
				exchangeRate: '4.85',
				amountTotal: 20000,
				amountTotalSettlement: 97000,
				payers: [{ memberId: 'm1', amountPaid: 20000 }]
			})
		);
		expect(res.success).toBe(true);
	});

	it('rejects a foreign currency with an incorrect amount_total_settlement', () => {
		const res = thbSchema.safeParse(
			baseSpending({
				currency: 'CNY',
				exchangeRate: '4.85',
				amountTotal: 20000,
				amountTotalSettlement: 96999, // off by one
				payers: [{ memberId: 'm1', amountPaid: 20000 }]
			})
		);
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes('amountTotalSettlement'))).toBe(true);
		}
	});

	it('rejects a rate with more than 6 fractional digits', () => {
		expect(
			thbSchema.safeParse(baseSpending({ currency: 'CNY', exchangeRate: '4.8500001' })).success
		).toBe(false);
	});
});

describe('buildTransactionSchema — optional member allow-list', () => {
	it('rejects a payer/beneficiary not in the allow-list when provided', () => {
		const schema = buildTransactionSchema({
			settlementCurrency: 'THB',
			memberIds: ['m1', 'm2'] // m3 missing
		});
		expect(schema.safeParse(baseSpending()).success).toBe(false);
	});

	it('accepts when all members are in the allow-list', () => {
		const schema = buildTransactionSchema({
			settlementCurrency: 'THB',
			memberIds: ['m1', 'm2', 'm3']
		});
		expect(schema.safeParse(baseSpending()).success).toBe(true);
	});
});
