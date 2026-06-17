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
// ── Scope (tasks 4.5 + 4.8) ───────────────────────────────────────────────────
// Resolves split_mode ∈ { equal, amount, share } (task 4.5) AND `itemized`
// (task 4.8 — `resolveItemizedShares`) in the TRANSACTION CURRENCY only. Itemized
// resolves EACH item via the SAME per-line equal/amount/share core, rounding
// WITHIN each item, then aggregates per member across items.
// Deliberately NOT here:
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
import type { TransactionInput, ItemInput } from '$lib/schemas/transaction';

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
	return resolveSplitLine(input.splitMode, input.amountTotal, input.beneficiaries);
}

/**
 * The SHARED per-split-line core (PLAN §7.2): resolve a single `target` total
 * across its `beneficiaries` by `mode` (equal/amount/share), rounding by
 * largest-remainder + ascending-`member_id` so the resolved owed sums **exactly**
 * to `target`. Used by BOTH the non-itemized {@link resolveShares} (the whole
 * transaction is one line) AND {@link resolveItemizedShares} (one call per item,
 * each item's `amount` its own target) — so the equal/amount/share math is ONE
 * code path at both levels and can never drift.
 *
 * @throws if `beneficiaries` is empty, or — defensively — an `amount` line is
 *   missing its `rawAmount`. `equal`/`share` weight errors surface from `distribute`.
 */
function resolveSplitLine(
	mode: 'equal' | 'amount' | 'share',
	target: number,
	beneficiaries: ResolveSharesInput['beneficiaries']
): ResolvedShare[] {
	if (beneficiaries.length === 0) {
		// The schema requires ≥1 beneficiary per split line (top-level or per item);
		// guard anyway so a misuse fails loudly rather than returning [] that can't sum.
		throw new Error('Cannot resolve shares for zero beneficiaries');
	}

	switch (mode) {
		case 'equal':
			// Every beneficiary gets weight 1; the remainder is handed out by the
			// largest-remainder + ascending-memberId rule inside `distribute`.
			return fromDistribute(
				target,
				beneficiaries.map((b) => ({ memberId: b.memberId, weight: 1 }))
			);

		case 'share':
			// Entered weights drive the proportional split; `distribute` rounds by
			// largest remainder and sums exactly to `target`.
			return fromDistribute(
				target,
				beneficiaries.map((b) => ({ memberId: b.memberId, weight: shareWeightOf(b) }))
			);

		case 'amount':
			// Passthrough: each owed IS the entered raw_amount. Σ raw_amount == target
			// is a §7.4 invariant already validated in 4.4, so the sum is exact by input.
			return beneficiaries.map((b) => ({
				memberId: b.memberId,
				amountOwed: rawAmountOf(b)
			}));
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Itemized resolution (PLAN §7.2.1 / §7.2.3 — task 4.8).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One item's resolution result: the per-member owed for THIS item (the
 * `transaction_item_share` rows), in the item's order. Returned alongside the
 * aggregated per-member totals so the service can persist BOTH the per-item
 * shares and the aggregated `transaction_share` rows from one resolver call.
 */
export interface ResolvedItem {
	/** The item this resolution is for (index into the input `items`). */
	readonly itemIndex: number;
	/** Per-member resolved owed for this item, in INPUT-beneficiary order. */
	readonly shares: ResolvedShare[];
}

/**
 * The full result of {@link resolveItemizedShares}: the per-item resolutions (for
 * the `transaction_item_share` rows) AND the aggregated per-member owed across all
 * items (the `transaction_share` rows — the §8 source of truth). For 4.8 there are
 * no charges, so each aggregated `amountOwed` IS the member's final owed and the
 * aggregated totals sum **exactly** to `items_subtotal` (= `amount_total`).
 */
export interface ResolvedItemized {
	/** Per-item resolved shares, one entry per input item, in input order. */
	readonly items: ResolvedItem[];
	/**
	 * Per-member owed aggregated across every item the member appears in. A member
	 * in some items and not others owes only the sum of the items they share. First
	 * appearance (lowest item index, then within-item input order) sets the order.
	 */
	readonly shares: ResolvedShare[];
}

/**
 * Resolve an ITEMIZED spending (PLAN §7.2.1 / §7.2.3 resolution, items-only for
 * 4.8). For each item: resolve its beneficiaries against the item's own `amount`
 * via the SHARED {@link resolveSplitLine} core (the same equal/amount/share +
 * largest-remainder/ascending-`member_id` rounding the non-itemized path uses),
 * so EACH item's shares sum EXACTLY to its `amount`. Then aggregate per member by
 * summing their owed across every item they appear in.
 *
 * Because each item sums exactly to its `amount`, the aggregated per-member totals
 * sum exactly to `Σ item.amount = items_subtotal`, which (no charges in 4.8) equals
 * `amount_total`. A member can be in some items and not others; their aggregated
 * owed is the sum of only the items they're in.
 *
 * Pure + client-importable (NOT `$lib/server`) — task 4.9's live breakdown calls it.
 *
 * @throws if `items` is empty (schema requires ≥1), or any item has zero
 *   beneficiaries / a missing `amount`-mode `rawAmount` (both schema-guaranteed;
 *   guarded defensively by the per-line core).
 */
export function resolveItemizedShares(items: readonly ItemInput[]): ResolvedItemized {
	if (items.length === 0) {
		// Schema requires ≥1 item for an itemized split; guard so misuse fails loudly
		// rather than producing an empty aggregate that can't sum to the subtotal.
		throw new Error('Cannot resolve an itemized split with zero items');
	}

	// Aggregate per member, preserving FIRST-APPEARANCE order (Map keeps insertion
	// order) so the aggregated `transaction_share` rows are deterministic.
	const aggregate = new Map<string, number>();

	const resolvedItems: ResolvedItem[] = items.map((item, itemIndex) => {
		// Resolve THIS item against its OWN amount — rounding happens WITHIN the item,
		// so the item's shares sum exactly to `item.amount`.
		const shares = resolveSplitLine(item.splitMode, item.amount, item.beneficiaries);
		for (const share of shares) {
			aggregate.set(share.memberId, (aggregate.get(share.memberId) ?? 0) + share.amountOwed);
		}
		return { itemIndex, shares };
	});

	const shares: ResolvedShare[] = [...aggregate].map(([memberId, amountOwed]) => ({
		memberId,
		amountOwed
	}));

	return { items: resolvedItems, shares };
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
