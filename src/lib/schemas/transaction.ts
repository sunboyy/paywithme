// Shared transaction Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// The SINGLE SOURCE OF TRUTH for the transaction create/edit INPUT payload —
// spending & transfer, including itemized splits + charges/discounts + manual FX
// (PLAN §7.1, §7.2, §7.2.1–7.2.3, §7.4, §7.6). The server `actions` (task 4.7)
// and the client `superForm` (tasks 4.7–4.11) both build their validation from
// this module, so the rules and their messages never drift across the boundary.
//
// ── What this schema DOES and DOES NOT do (scope, PLAN §7.4) ──────────────────
// It validates every §7.4 rule that is decidable from the SUBMITTED PAYLOAD
// ALONE — structural shape and cross-field math within the input, all in
// integer MINOR UNITS of the transaction currency. Specifically it enforces:
//   - ≥1 payer and ≥1 beneficiary; `Σ amount_paid == amount_total`.
//   - split_mode `amount`:   `Σ raw_amount == amount_total`.
//   - split_mode `share`:    weights ≥0 and `Σ share_weight > 0`.
//   - split_mode `equal`:    beneficiaries listed; no per-member amount/weight.
//   - split_mode `itemized` (spending only — Transfers are NOT itemized, §7.2.3):
//       ≥1 item; each item amount>0, ≥1 beneficiary, and its own split valid;
//       the §7.2.2 charge model (kind/mode/value/base/sort_order) shape; the
//       `amount_total == items_subtotal + Σ signed charge effects (in order)`
//       equality computed with integer round-half-up math; discount ≤ its base
//       and `amount_total >= 0`.
//   - category: a known category id whose `applies_to` matches `type`.
//   - FX (§7.6): supported `currency`; rate==1 iff `currency` == settlement;
//       rate>0 for a foreign currency; and the SCALAR
//       `amount_total_settlement == convert(amount_total, rate)`.
//
// It DELIBERATELY DOES NOT do (out of scope for task 4.4 — noted at each rule):
//   - **Split RESOLUTION** (equal/share/amount/itemized → per-member resolved
//     `amount_owed`, with largest-remainder rounding + tie-break): that is task
//     4.5, which calls `lib/money` `distribute`. This schema validates the raw
//     INPUT; it never resolves shares. Consequently the §7.4 rules that require
//     the RESOLVED outputs — `Σ(resolved amount_owed) == amount_total`, and the
//     settlement-side tie-out `Σ amount_paid_settlement == Σ amount_owed[stl] ==
//     amount_total_settlement` — are enforced AFTER resolution (4.5) + the §7.6
//     per-share distribution (4.10), NOT here. Only the scalar settlement total
//     (`amount_total_settlement`) is input-level, so only it is checked here.
//   - **Membership / DB checks** ("members must belong to the transaction's
//     group", category/currency existence vs the seeded DB rows): those need
//     server/DB context and are enforced in the server action (task 4.7). This
//     pure schema only checks ids against the in-app `CATEGORIES` constant and
//     `currencyCodeSchema`; it never reaches into the DB.
//
// ── Money & numeric representation (decisions, documented) ───────────────────
// All money fields are **integer minor units** of the transaction currency — the
// canonical persisted form (task 4.1/4.2 store these as `bigint`/number). The
// CLIENT parses the user's display strings → minor units via `lib/money`
// `parseAmount` BEFORE submit; this schema therefore validates ALREADY-PARSED
// non-negative safe integers (`minorUnitsField`), never floats and never raw
// strings. This keeps one numeric contract end-to-end (Drizzle `bigint`/number,
// JSON, Zod) with no float math anywhere — money rules from CLAUDE.md.
// `exchange_rate` is the lone non-minor-unit numeric: a `numeric(18,6)` decimal
// (§7.6) carried as a STRING (Drizzle returns numeric as a string), validated for
// shape (≤6 fractional digits) and `> 0` by `exchangeRateField`.
//
// ── Settlement currency: a SCHEMA FACTORY, not a payload field (decision) ─────
// The group's settlement currency is GROUP CONTEXT — it is not (and must not be)
// trusted from the client payload, where a forged value could flip the rate==1
// rule. So the schema is produced by `buildTransactionSchema({ settlementCurrency
// })`, which CLOSES OVER the group's settlement currency. The exact same factory
// runs on the server (settlement currency loaded from the group row) and the
// client (settlement currency passed into the page). One schema, one set of
// rules/messages, no untrusted context field. (The factory also accepts an
// optional `memberIds` allow-list so a later task can tighten member-id checks
// without a DB round-trip; left unused here — full membership is the action's job.)

import { z } from 'zod';
import { getCurrency, type CurrencyCode } from '$lib/money';
import { getCategory } from '$lib/categories';
import { currencyCodeSchema } from './currency';

// ─────────────────────────────────────────────────────────────────────────────
// Shared field rules (factored out so messages never drift — mirrors group.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A money amount in integer **minor units** (already parsed from the user's
 * display string via `lib/money` `parseAmount` on the client). Non-negative,
 * finite, a SAFE integer (`Number.isSafeInteger`) — rejects floats, NaN, ±∞, and
 * magnitudes past `MAX_SAFE_MINOR`. The single rule behind `amount_total`,
 * `amount_paid`, item `amount`, `raw_amount`, and absolute charge `value`, so the
 * "minor units, no floats" contract is identical everywhere.
 */
const minorUnitsField = z
	.number({ message: 'Amount is required' })
	.int({ message: 'Amount must be in whole minor units' })
	.nonnegative({ message: 'Amount must be zero or more' })
	.safe({ message: 'Amount is out of range' });

/**
 * A non-negative integer share weight (`split_mode = share`, §7.2). Zero is
 * allowed PER MEMBER (a member can carry weight 0); the cross-field rule then
 * requires `Σ weight > 0` overall.
 */
const shareWeightField = z
	.number({ message: 'A share weight is required' })
	.int({ message: 'Share weight must be a whole number' })
	.nonnegative({ message: 'Share weight must be zero or more' })
	.safe({ message: 'Share weight is out of range' });

/** A non-empty member id (an in-app text PK; full membership is checked in the action). */
const memberIdField = z.string().trim().min(1, { message: 'A member is required' });

/** A transaction / item title (required, trimmed, length-bounded — matches group/member name caps). */
const titleField = z
	.string()
	.trim()
	.min(1, { message: 'A title is required' })
	.max(200, { message: 'Title must be 200 characters or fewer' });

/**
 * `exchange_rate` field (§7.6): settlement-currency units per 1 transaction-currency
 * unit, a `numeric(18,6)` carried as a STRING (Drizzle returns numeric as string).
 * Validates the decimal SHAPE only here — up to 12 integer digits and AT MOST 6
 * fractional digits (the `numeric(18,6)` envelope) and strictly `> 0`. The
 * relationship to the currency (==1 vs >0) is a cross-field rule applied in the
 * built schema. Parsed value is the normalized string.
 */
const exchangeRateField = z
	.string({ message: 'An exchange rate is required' })
	.trim()
	.regex(/^\d{1,12}(?:\.\d{1,6})?$/, {
		message: 'Exchange rate must be a positive number with up to 6 decimal places'
	})
	.refine((s) => Number(s) > 0, { message: 'Exchange rate must be greater than 0' });

/** Transaction type (PLAN §7.1). Drives which categories apply and whether itemized is allowed. */
const transactionTypeSchema = z.enum(['spending', 'transfer'], {
	message: 'Select a transaction type'
});

/** Top-level split mode (PLAN §7.2). `itemized` is spending-only (§7.2.3, enforced below). */
const splitModeSchema = z.enum(['equal', 'amount', 'share', 'itemized'], {
	message: 'Select a split mode'
});

/** Per-item split mode (PLAN §7.2.1) — items are never themselves itemized. */
const itemSplitModeSchema = z.enum(['equal', 'amount', 'share'], {
	message: 'Select a split mode for the item'
});

// ─────────────────────────────────────────────────────────────────────────────
// Charge model (PLAN §7.2.2) — sub-schema + the integer charge-effect engine.
// ─────────────────────────────────────────────────────────────────────────────

/** The maximum basis points for a `percent` charge: 10000 bps = 100.00% (§7.4). */
export const MAX_PERCENT_BPS = 10_000;

/**
 * A single charge / discount row (PLAN §7.2.2). `value` is ALWAYS a non-negative
 * MAGNITUDE — the sign is derived from `kind` (`service`/`vat`/`tip` add,
 * `discount` subtracts). The semantic range of `value` depends on `mode`:
 *   - `percent`  → BASIS POINTS, an integer in 0–10000 (0–100.00%, §7.4).
 *   - `absolute` → transaction-currency MINOR UNITS (a non-negative safe integer).
 * That mode-dependent bound is applied as a refinement (one `value` field can't
 * express two ranges). `base` selects what a `percent` applies to; `sort_order`
 * is the application order.
 */
const chargeSchema = z
	.object({
		// `tip` is reserved by §7.2.2 ("extensible later") and treated as an additive
		// kind; v1 entry uses service/vat/discount but accepting tip keeps the schema
		// forward-compatible with the DB column's documented value set.
		kind: z.enum(['service', 'vat', 'discount', 'tip'], { message: 'Select a charge kind' }),
		mode: z.enum(['percent', 'absolute'], { message: 'Select a charge mode' }),
		// Non-negative magnitude; the mode-specific upper bound is refined below.
		value: minorUnitsField,
		base: z.enum(['items_subtotal', 'running_total'], { message: 'Select a charge base' }),
		sortOrder: z
			.number({ message: 'A sort order is required' })
			.int({ message: 'Sort order must be a whole number' })
			.nonnegative({ message: 'Sort order must be zero or more' })
	})
	.refine((c) => c.mode !== 'percent' || c.value <= MAX_PERCENT_BPS, {
		// `percent` value is basis points, 0–10000 (PLAN §7.4).
		message: 'A percentage charge must be between 0 and 10000 basis points (0–100%)',
		path: ['value']
	});

/** Inferred single-charge input (PLAN §7.2.2). */
export type ChargeInput = z.infer<typeof chargeSchema>;

/** `true` for additive kinds (service/vat/tip), `false` for the subtractive `discount` (§7.2.2). */
function chargeAdds(kind: ChargeInput['kind']): boolean {
	return kind !== 'discount';
}

/**
 * Round-half-up division of two non-negative integers — exact integer math (no
 * floats). The operands are taken as `bigint` and the division is done in BigInt
 * so a large numerator (e.g. `base × 10000` for a percent charge, which exceeds
 * `Number.MAX_SAFE_INTEGER` above ~9e11 minor units) can never silently overflow.
 * Callers pass `number`s widened with `BigInt(...)`; the safe-integer result is
 * returned as a `number` after a `Number.isSafeInteger` guard.
 */
function divRoundHalfUp(numerator: bigint, denominator: bigint): number {
	// numerator, denominator ≥ 0, denominator > 0. Add half the denominator before
	// the floor-divide so exactly-.5 rounds UP, matching §7.2.2 / §7.6 "round-half-up".
	const result = (numerator + denominator / 2n) / denominator;
	const asNumber = Number(result);
	if (!Number.isSafeInteger(asNumber)) {
		throw new Error(`Rounded result out of safe-integer range: ${result}`);
	}
	return asNumber;
}

/**
 * One charge's RESOLVED effect after the §7.2.2 fold — the signed minor-unit
 * amount it contributed to the running total, in the order it was applied. This
 * is what the resolver (task 4.9) ALLOCATES across members in proportion to their
 * subtotal share. `applyCharges` returns one of these per input charge, in
 * `sort_order` (the application order), so the resolver and the breakdown UI read
 * the exact per-charge totals the fold produced.
 */
export interface ResolvedChargeEffect {
	/** The originating charge (echoed so the caller can persist / label it). */
	readonly charge: ChargeInput;
	/**
	 * This charge's SIGNED effect on the running total, in transaction-currency
	 * minor units: `+magnitude` for additive kinds (service/vat/tip), `−magnitude`
	 * for a discount. Summing every `signedEffect` and adding `items_subtotal`
	 * yields `amountTotal`.
	 */
	readonly signedEffect: number;
}

/**
 * Result of folding the ordered charges over an items subtotal (PLAN §7.2.2):
 * the computed `amount_total`, whether any single discount's MAGNITUDE exceeded
 * the base it applied to (a §7.4 violation surfaced to the caller), and the
 * per-charge resolved signed effects (in application order) — the latter added
 * for task 4.9's proportional allocation. The first two fields are unchanged, so
 * existing callers that destructure `{ amountTotal, discountExceedsBase }` keep
 * working (the new field is purely additive).
 */
interface ChargeFoldResult {
	/** `items_subtotal + Σ signed charge effects`, in transaction-currency minor units. */
	readonly amountTotal: number;
	/** A discount magnitude exceeded the base it was computed against (§7.4). */
	readonly discountExceedsBase: boolean;
	/**
	 * Each charge's signed effect, in `sort_order` (application order). `Σ
	 * perCharge.signedEffect + items_subtotal === amountTotal`. Task 4.9 allocates
	 * each `signedEffect` across members by subtotal share.
	 */
	readonly perCharge: ResolvedChargeEffect[];
}

/**
 * Apply the §7.2.2 charge model to an items subtotal, in `sort_order`, with
 * integer round-half-up math (NO floats), returning the resulting `amount_total`.
 *
 * For each charge in order:
 *   - a `percent` charge's magnitude = round(base × value_bps / 10000), where
 *     `base` is the items subtotal or the running total per the row's `base`;
 *   - an `absolute` charge's magnitude is the stored minor-unit `value` directly;
 *   - the effect is +magnitude (service/vat/tip) or −magnitude (discount), applied
 *     to the running total.
 *
 * Also flags whether any discount's magnitude exceeded the base it was computed
 * against (PLAN §7.4: "total discount must not exceed its base"), and returns the
 * per-charge SIGNED effects in application order ({@link ResolvedChargeEffect}) so
 * the itemized resolver (task 4.9) can allocate each charge across members by
 * subtotal share. Pure; shared by the itemized refinement so the validation math
 * is the exact production fold the resolver re-uses.
 */
export function applyCharges(
	itemsSubtotal: number,
	charges: readonly ChargeInput[]
): ChargeFoldResult {
	let running = itemsSubtotal;
	let discountExceedsBase = false;
	const perCharge: ResolvedChargeEffect[] = [];

	const ordered = [...charges].sort((a, b) => a.sortOrder - b.sortOrder);
	for (const charge of ordered) {
		const base = charge.base === 'items_subtotal' ? itemsSubtotal : running;
		const magnitude =
			charge.mode === 'percent'
				? // `base × value_bps` overflows MAX_SAFE_INTEGER above ~9e11 minor units;
					// do it in BigInt so a large bill can never silently overflow (§7.2.2).
					divRoundHalfUp(BigInt(base) * BigInt(charge.value), BigInt(MAX_PERCENT_BPS))
				: charge.value;

		// Sign from kind (§7.2.2): service/vat/tip add, discount subtracts. The
		// SIGNED effect is recorded per charge so task 4.9 can allocate it.
		const signedEffect = chargeAdds(charge.kind) ? magnitude : -magnitude;
		if (!chargeAdds(charge.kind) && magnitude > base) {
			// Discount: must not exceed the base it applies to (§7.4).
			discountExceedsBase = true;
		}
		running += signedEffect;
		perCharge.push({ charge, signedEffect });
	}

	return { amountTotal: running, discountExceedsBase, perCharge };
}

// ─────────────────────────────────────────────────────────────────────────────
// FX conversion (PLAN §7.6) — the scalar settlement-total check.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an integer minor-unit `amount` from `txnCurrency` to `settlementCurrency`
 * at `exchangeRate` (a `numeric(18,6)` string), per the PLAN §7.6 formula:
 *
 *   amount_settlement_minor =
 *     round( amount_txn_minor / 10^exp_txn × rate × 10^exp_settlement )
 *
 * Implemented with EXACT integer arithmetic (no binary float, §7.6): the rate
 * string is scaled to an integer of fixed 6-dp precision, and the whole expression
 * is one rational `numerator / denominator` rounded HALF-UP. Pure helper; the
 * built schema uses it for the scalar `amount_total_settlement` equality check
 * (the per-share settlement DISTRIBUTION is task 4.10, deliberately not here).
 *
 * @example convertToSettlement(20000, 'CNY', 'THB', '4.85') // ¥200.00 → ฿970.00 = 97000
 * @example convertToSettlement(20000, 'CNY', 'JPY', '21.5') // ¥200.00 → ¥4300 (0-dp) = 4300
 */
export function convertToSettlement(
	amount: number,
	txnCurrency: CurrencyCode,
	settlementCurrency: CurrencyCode,
	exchangeRate: string
): number {
	const expTxn = currencyExponent(txnCurrency);
	const expStl = currencyExponent(settlementCurrency);

	// rate (≤6 fractional digits) → an integer scaled by 10^6, exactly.
	const RATE_SCALE = 1_000_000;
	const rateScaled = rateToScaledInteger(exchangeRate, RATE_SCALE);

	// amount / 10^expTxn × (rateScaled / 10^6) × 10^expStl
	//   = amount × rateScaled × 10^expStl / (10^expTxn × 10^6)
	//
	// The numerator `amount × rateScaled × 10^expStl` overflows
	// `Number.MAX_SAFE_INTEGER` at realistic amounts (rateScaled is scaled by 10^6,
	// so e.g. CNY→THB @4.85 overflows above ~¥185,715), and the overflow is SILENT.
	// PLAN §7.6 requires integer/bignum scaling — so we do the whole rational in
	// BigInt and convert back to `number` only for the final minor-unit result.
	// `amount` is a non-negative minor-unit integer (`minorUnitsField`) and
	// `rateScaled` is non-negative, so all operands are ≥ 0 and round-half-up is a
	// plain `+ half` before the floor-divide (no negative-rounding direction to pick).
	const numerator = BigInt(amount) * BigInt(rateScaled) * 10n ** BigInt(expStl);
	const denominator = 10n ** BigInt(expTxn) * BigInt(RATE_SCALE);
	const half = denominator / 2n;
	const resultBig = (numerator + half) / denominator;

	const result = Number(resultBig);
	if (!Number.isSafeInteger(result)) {
		// A too-large RESULT must never silently appear either (§7.6 / "no floats").
		throw new Error(`Settlement conversion result out of safe-integer range: ${resultBig}`);
	}
	return result;
}

/** Resolve a currency's minor-unit exponent, throwing on an unknown code (defensive — validated upstream). */
function currencyExponent(code: CurrencyCode): number {
	const currency = getCurrency(code);
	if (currency === undefined) {
		throw new Error(`Unknown currency code: ${String(code)}`);
	}
	return currency.exponent;
}

/**
 * Parse a validated `numeric(18,6)` rate STRING (shape already checked by
 * `exchangeRateField`) into an integer scaled by `scale` (10^6), exactly, with no
 * float multiply: split on the decimal point and pad the fraction to 6 digits.
 */
function rateToScaledInteger(rate: string, scale: number): number {
	// `scale` is 10^6 → exactly 6 fractional digits, matching `numeric(18,6)`.
	const fractionDigits = Math.round(Math.log10(scale));
	const [intPart, fracPart = ''] = rate.split('.');
	const paddedFrac = fracPart.padEnd(fractionDigits, '0').slice(0, fractionDigits);
	return Number(`${intPart}${paddedFrac}`.replace(/^0+(?=\d)/, ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// Building blocks: payers, shares, items.
// ─────────────────────────────────────────────────────────────────────────────

/** A payer line (PLAN §7.2): a member and what they paid, in txn-currency minor units. */
const payerSchema = z.object({
	memberId: memberIdField,
	amountPaid: minorUnitsField
});

/**
 * A beneficiary/share line (PLAN §7.2). The optional per-member inputs depend on
 * the split mode (validated by the cross-field refinements in the built schema):
 *   - `amount` split → `rawAmount` (minor units) per member;
 *   - `share`  split → `shareWeight` per member;
 *   - `equal`  split → neither (amount_total split evenly).
 */
const shareSchema = z.object({
	memberId: memberIdField,
	rawAmount: minorUnitsField.optional(),
	shareWeight: shareWeightField.optional()
});

/**
 * One itemized line item (PLAN §7.2.1): a label, an amount (>0, refined below),
 * its own per-item split mode, and its beneficiaries (≥1, refined below). Each
 * item's own split must be internally valid (amount/share rules per item, §7.4).
 */
const itemSchema = z
	.object({
		label: titleField,
		amount: minorUnitsField,
		splitMode: itemSplitModeSchema,
		beneficiaries: z.array(shareSchema)
	})
	.refine((item) => item.amount > 0, {
		// Each item amount must be > 0 (PLAN §7.4 / §7.2.1).
		message: 'Each item amount must be greater than 0',
		path: ['amount']
	})
	.refine((item) => item.beneficiaries.length >= 1, {
		// Each item needs ≥1 beneficiary (PLAN §7.4 / §7.2.3 edge case).
		message: 'Each item needs at least one beneficiary',
		path: ['beneficiaries']
	})
	.refine((item) => splitInputsValid(item.splitMode, item.amount, item.beneficiaries), {
		// Each item's own split must be valid: amount → Σ rawAmount == item amount;
		// share → Σ weight > 0; equal → nothing extra (PLAN §7.4, per item).
		message: 'This item split does not add up to the item amount',
		path: ['beneficiaries']
	});

/** Inferred item input (PLAN §7.2.1). */
export type ItemInput = z.infer<typeof itemSchema>;

/**
 * Validate a split's per-member inputs against a target total (PLAN §7.4). Shared
 * by the top-level non-itemized split check AND each item's own split check, so
 * the amount/share rules read identically at both levels:
 *   - `amount` → every beneficiary has a `rawAmount` and `Σ rawAmount == total`;
 *   - `share`  → `Σ shareWeight > 0` (weights are already ≥0 by field rule);
 *   - `equal`  → always valid (beneficiaries split `total` evenly).
 *
 * NOTE: this checks the INPUT adds up; it does NOT resolve per-member owed amounts
 * — that largest-remainder resolution is task 4.5.
 */
function splitInputsValid(
	mode: 'equal' | 'amount' | 'share',
	total: number,
	beneficiaries: readonly { rawAmount?: number; shareWeight?: number }[]
): boolean {
	if (beneficiaries.length === 0) {
		return false;
	}
	switch (mode) {
		case 'equal':
			return true;
		case 'amount': {
			if (beneficiaries.some((b) => b.rawAmount === undefined)) {
				return false;
			}
			const sum = beneficiaries.reduce((acc, b) => acc + (b.rawAmount ?? 0), 0);
			return sum === total;
		}
		case 'share': {
			const sum = beneficiaries.reduce((acc, b) => acc + (b.shareWeight ?? 0), 0);
			return sum > 0;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The schema factory.
// ─────────────────────────────────────────────────────────────────────────────

/** Options closed over by {@link buildTransactionSchema}. */
export interface BuildTransactionSchemaOptions {
	/**
	 * The GROUP's settlement currency (group context — NOT trusted from the
	 * payload). Drives the FX rate==1-vs->0 rule and the scalar settlement-total
	 * conversion. Must be a supported `CurrencyCode`.
	 */
	readonly settlementCurrency: CurrencyCode;
	/**
	 * Optional member-id allow-list. When provided, every payer/beneficiary id must
	 * be in it (a cheap structural guard a later task may enable). When omitted,
	 * full membership ("members belong to the group") is left to the server action
	 * (task 4.7) — the pure schema never reaches into the DB.
	 */
	readonly memberIds?: readonly string[];
}

/**
 * Build the shared transaction create/edit input schema, closing over the group's
 * `settlementCurrency` (and optional member allow-list). The SAME factory runs on
 * the server (currency from the group row) and the client (currency from the page
 * data), so the validation rules and messages are identical on both sides.
 *
 * Returns a Zod schema whose parsed output is a normalized {@link TransactionInput}.
 */
export function buildTransactionSchema(options: BuildTransactionSchemaOptions) {
	const { settlementCurrency, memberIds } = options;
	const knownMembers = memberIds === undefined ? undefined : new Set(memberIds);

	return (
		z
			.object({
				type: transactionTypeSchema,
				title: titleField,
				categoryId: z.string().trim().min(1, { message: 'A category is required' }),
				// Transaction-currency total, integer minor units (already parsed on client).
				amountTotal: minorUnitsField,
				currency: currencyCodeSchema,
				exchangeRate: exchangeRateField,
				// Canonical settlement total (settlement-currency minor units) — its
				// equality to convert(amountTotal, rate) is checked below (§7.6 scalar).
				amountTotalSettlement: minorUnitsField,
				splitMode: splitModeSchema,
				payers: z.array(payerSchema),
				beneficiaries: z.array(shareSchema),
				// Present only for split_mode = itemized (spending). Empty otherwise.
				items: z.array(itemSchema).default([]),
				charges: z.array(chargeSchema).default([])
			})
			// ── ≥1 payer (PLAN §7.4). ────────────────────────────────────────────────
			.refine((tx) => tx.payers.length >= 1, {
				message: 'At least one payer is required',
				path: ['payers']
			})
			// ── ≥1 beneficiary (PLAN §7.4). For itemized the beneficiaries live on the
			//    items, so require ≥1 item instead (each item then needs ≥1 beneficiary).
			.refine((tx) => (tx.splitMode === 'itemized' ? true : tx.beneficiaries.length >= 1), {
				message: 'At least one beneficiary is required',
				path: ['beneficiaries']
			})
			// ── Σ amount_paid == amount_total (PLAN §7.4), txn-currency minor units. ──
			.refine((tx) => tx.payers.reduce((acc, p) => acc + p.amountPaid, 0) === tx.amountTotal, {
				message: 'The amounts paid must add up to the transaction total',
				path: ['payers']
			})
			// ── itemized is spending-only (PLAN §7.2.3). ─────────────────────────────
			.refine((tx) => !(tx.type === 'transfer' && tx.splitMode === 'itemized'), {
				message: 'Transfers cannot be itemized',
				path: ['splitMode']
			})
			// ── category: a known id whose applies_to matches type (PLAN §7.3). The
			//    EXISTENCE-in-DB check is the action's job; here we check the constant. ─
			.refine(
				(tx) => {
					const category = getCategory(tx.categoryId);
					return category !== undefined && category.appliesTo === tx.type;
				},
				{ message: 'Select a category for this transaction type', path: ['categoryId'] }
			)
			// ── non-itemized split inputs add up (PLAN §7.4: amount/share/equal). ────
			.refine(
				(tx) =>
					tx.splitMode === 'itemized' ||
					splitInputsValid(tx.splitMode, tx.amountTotal, tx.beneficiaries),
				{
					message: 'The split does not add up to the transaction total',
					path: ['beneficiaries']
				}
			)
			// ── itemized: ≥1 item (PLAN §7.4). ───────────────────────────────────────
			.refine((tx) => tx.splitMode !== 'itemized' || tx.items.length >= 1, {
				message: 'An itemized transaction needs at least one item',
				path: ['items']
			})
			// ── itemized: amount_total == items_subtotal + Σ signed charges (§7.2.2). ─
			.refine(
				(tx) => {
					if (tx.splitMode !== 'itemized') {
						return true;
					}
					const subtotal = tx.items.reduce((acc, item) => acc + item.amount, 0);
					const { amountTotal } = applyCharges(subtotal, tx.charges);
					return amountTotal === tx.amountTotal;
				},
				{
					message: 'The transaction total must equal the items subtotal plus charges',
					path: ['amountTotal']
				}
			)
			// ── itemized: no discount exceeds its base (PLAN §7.4). ──────────────────
			.refine(
				(tx) => {
					if (tx.splitMode !== 'itemized') {
						return true;
					}
					const subtotal = tx.items.reduce((acc, item) => acc + item.amount, 0);
					return !applyCharges(subtotal, tx.charges).discountExceedsBase;
				},
				{ message: 'A discount cannot exceed the amount it applies to', path: ['charges'] }
			)
			// ── itemized: amount_total >= 0 after charges (PLAN §7.4). ───────────────
			.refine(
				(tx) => {
					if (tx.splitMode !== 'itemized') {
						return true;
					}
					const subtotal = tx.items.reduce((acc, item) => acc + item.amount, 0);
					return applyCharges(subtotal, tx.charges).amountTotal >= 0;
				},
				{ message: 'The transaction total cannot be negative', path: ['amountTotal'] }
			)
			// ── FX: rate == 1 iff currency == settlement (PLAN §7.6 / §7.4). ─────────
			.refine((tx) => tx.currency !== settlementCurrency || Number(tx.exchangeRate) === 1, {
				message: 'When the currency matches the group settlement currency the rate must be 1',
				path: ['exchangeRate']
			})
			// ── FX: a foreign currency requires rate > 0 (the field already enforces
			//    > 0; this keeps the intent explicit and the message FX-specific). ────
			.refine((tx) => tx.currency === settlementCurrency || Number(tx.exchangeRate) > 0, {
				message: 'A foreign-currency transaction requires an exchange rate greater than 0',
				path: ['exchangeRate']
			})
			// ── FX scalar: amount_total_settlement == convert(amount_total, rate)
			//    (PLAN §7.6 formula). Per-SHARE settlement distribution is task 4.10. ──
			.refine(
				(tx) =>
					tx.amountTotalSettlement ===
					// `currency` is already validated as a supported code by `currencyCodeSchema`;
					// the inferred type is the broad `string` (the enum tuple is `[string, ...]`),
					// so narrow it to `CurrencyCode` for the conversion helper.
					convertToSettlement(
						tx.amountTotal,
						tx.currency as CurrencyCode,
						settlementCurrency,
						tx.exchangeRate
					),
				{
					message: 'The settlement total must equal the converted transaction total',
					path: ['amountTotalSettlement']
				}
			)
			// ── optional member allow-list (when provided). Full membership = action. ─
			.refine(
				(tx) => {
					if (knownMembers === undefined) {
						return true;
					}
					const ids = [
						...tx.payers.map((p) => p.memberId),
						...tx.beneficiaries.map((b) => b.memberId),
						...tx.items.flatMap((item) => item.beneficiaries.map((b) => b.memberId))
					];
					return ids.every((id) => knownMembers.has(id));
				},
				{ message: 'A selected member is not part of this group', path: ['payers'] }
			)
	);
}

/**
 * The transaction input schema TYPE — inferred from the factory's return so the
 * server action and client `superForm` share one type. We infer from a sample
 * build (the shape is identical for any settlement currency; only refinements
 * differ, which don't affect the output type).
 */
export type TransactionSchema = ReturnType<typeof buildTransactionSchema>;

/** Inferred, normalized transaction create/edit input — shared by server action + client form. */
export type TransactionInput = z.infer<TransactionSchema>;
