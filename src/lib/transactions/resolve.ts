// Non-itemized split resolution (PLAN §7.2 — task 4.5).
//
// Given a SCHEMA-VALID transaction's split inputs (the `split_mode` and the
// per-beneficiary `raw_amount` / `share_weight` from `lib/schemas/transaction`,
// task 4.4), produce each beneficiary's RESOLVED `amount_owed` in
// transaction-currency MINOR UNITS — the source-of-truth value §8 debt math
// reads. Every mode's resolved owed amounts sum **exactly** to `amount_total`,
// using largest-remainder rounding with the ascending-`member_id` tie-break.
//
// ── Why this lives in `src/lib/transactions/` (NOT `$lib/server`) ─────────────
// The transaction form's live breakdown UI (task 4.9) resolves shares CLIENT-side
// for a live preview, and SvelteKit forbids importing `$lib/server` on the client.
// So this resolver is a SHARED, pure module: no DB, no IO, no side effects — just
// money math. It is the production resolver the server action (4.7) and the client
// form both call, so the resolved owed amounts are computed by ONE code path on
// both sides and can never drift. A new `src/lib/transactions/` dir (rather than
// co-locating under `lib/money`) keeps the generic largest-remainder primitive
// (`distribute`) separate from this transaction-domain resolver that consumes it.
//
// ── Scope (task 4.5 only) ─────────────────────────────────────────────────────
// Resolves split_mode ∈ { equal, amount, share } in the TRANSACTION CURRENCY only.
// Deliberately NOT here:
//   - `itemized` resolution (per-item splits aggregated)        → task 4.8.
//   - charges / discounts allocation                            → task 4.9.
//   - FX / settlement conversion of the resolved owed amounts   → task 4.10.
// Input is assumed schema-valid (validation is task 4.4); we assert a couple of
// invariants defensively but never re-validate.
//
// ── Reuse ─────────────────────────────────────────────────────────────────────
// `equal` and `share` delegate to `lib/money` `distribute` (task 4.1), the shared
// largest-remainder primitive that already does the ascending-`member_id`
// tie-break and sums EXACTLY to the total — this module never re-implements it.

import { distribute } from '$lib/money';
import type { TransactionInput } from '$lib/schemas/transaction';

/**
 * One beneficiary's resolved share (PLAN §7.2 `transaction_share`). `amountOwed`
 * is in transaction-currency MINOR UNITS — the persisted source of truth for §8
 * debt math. The resolver returns one of these per input beneficiary.
 */
export interface ResolvedShare {
	/** The beneficiary member id, echoed from the input. */
	readonly memberId: string;
	/** This member's resolved owed amount, in transaction-currency minor units. */
	readonly amountOwed: number;
}

/**
 * The exact slice of a {@link TransactionInput} this resolver needs: the
 * non-itemized `split_mode`, the `amount_total` (txn-currency minor units), and
 * the validated beneficiary lines. Pulled FROM the shared schema's inferred type
 * (`Pick`) so the resolver and the schema stay structurally aligned — no parallel
 * input shape to drift. `itemized` is intentionally excluded (task 4.8 owns it).
 */
export interface ResolveSharesInput {
	/** Non-itemized split mode (PLAN §7.2). `itemized` is resolved separately (4.8). */
	readonly splitMode: Exclude<TransactionInput['splitMode'], 'itemized'>;
	/** The transaction total to distribute, txn-currency minor units. */
	readonly amountTotal: TransactionInput['amountTotal'];
	/** The validated beneficiary lines (`memberId` + optional `rawAmount` / `shareWeight`). */
	readonly beneficiaries: TransactionInput['beneficiaries'];
}

/**
 * Resolve a non-itemized transaction's beneficiary shares to per-member
 * `amount_owed` in transaction-currency MINOR UNITS (PLAN §7.2), dispatching on
 * `split_mode`:
 *
 *   - **equal**  — split `amount_total` evenly: `distribute(total, weight=1 each)`.
 *   - **share**  — `amount_total × weight / Σ weights`, largest-remainder rounded:
 *                  `distribute(total, weight = each shareWeight)`.
 *   - **amount** — each owed = its entered `raw_amount` (passthrough; §7.4 already
 *                  validated `Σ raw_amount == amount_total` in task 4.4).
 *
 * For EVERY mode the returned `amountOwed` values sum **exactly** to `amountTotal`
 * in minor units, and ties in the largest-remainder rounding go to the lower
 * `member_id` (ascending) — both inherited from `distribute`.
 *
 * Order: results are returned in the SAME order as the input `beneficiaries`
 * (input order). `distribute` echoes its `shares` order, and `amount` maps
 * in place, so this holds for every mode.
 *
 * @throws if `beneficiaries` is empty (schema requires ≥1), or — defensively — if
 *   an `amount` line is missing its `rawAmount` (schema guarantees it is present).
 *   `equal`/`share` weight errors surface from `distribute`.
 */
export function resolveShares(input: ResolveSharesInput): ResolvedShare[] {
	const { splitMode, amountTotal, beneficiaries } = input;

	if (beneficiaries.length === 0) {
		// The schema requires ≥1 beneficiary for non-itemized splits; guard anyway so
		// a misuse fails loudly rather than silently returning [] that can't sum to total.
		throw new Error('Cannot resolve shares for zero beneficiaries');
	}

	switch (splitMode) {
		case 'equal':
			// Every beneficiary gets weight 1; the remainder is handed out by the
			// largest-remainder + ascending-memberId rule inside `distribute`.
			return fromDistribute(
				amountTotal,
				beneficiaries.map((b) => ({ memberId: b.memberId, weight: 1 }))
			);

		case 'share':
			// Entered weights drive the proportional split; `distribute` rounds by
			// largest remainder and sums exactly to `amountTotal`.
			return fromDistribute(
				amountTotal,
				beneficiaries.map((b) => ({ memberId: b.memberId, weight: shareWeightOf(b) }))
			);

		case 'amount':
			// Passthrough: each owed IS the entered raw_amount. Σ raw_amount == amountTotal
			// is a §7.4 invariant already validated in 4.4, so the sum is exact by input.
			return beneficiaries.map((b) => ({
				memberId: b.memberId,
				amountOwed: rawAmountOf(b)
			}));
	}
}

/**
 * Run `distribute` for the equal/share modes and re-key its `DistributeResult`
 * (`{ memberId, amount }`) into a {@link ResolvedShare} (`{ memberId, amountOwed }`).
 * `memberId` here is always the schema's `string` member id, so it is narrowed
 * back from `distribute`'s `string | number` union without loss.
 */
function fromDistribute(
	amountTotal: number,
	shares: readonly { memberId: string; weight: number }[]
): ResolvedShare[] {
	return distribute(amountTotal, shares).map((r) => ({
		memberId: String(r.memberId),
		amountOwed: r.amount
	}));
}

/**
 * The `share_weight` for a `share`-mode beneficiary. The schema makes it optional
 * (it is absent for other modes), but a `share` split has it on every line by
 * §7.4; a missing one defaults to 0 (a zero-weight member, also schema-allowed).
 */
function shareWeightOf(b: ResolveSharesInput['beneficiaries'][number]): number {
	return b.shareWeight ?? 0;
}

/**
 * The `raw_amount` for an `amount`-mode beneficiary. Schema-optional in the shared
 * shape but REQUIRED (and present) for `amount` mode by §7.4; we assert it rather
 * than silently coercing, so a contract violation upstream fails loudly here.
 */
function rawAmountOf(b: ResolveSharesInput['beneficiaries'][number]): number {
	if (b.rawAmount === undefined) {
		throw new Error(`amount-mode beneficiary "${b.memberId}" is missing its raw_amount`);
	}
	return b.rawAmount;
}
