// Net balance per member (PLAN §8.1 — task 5.1).
//
// The PURE core of the §8 debt math: given a group's per-member settlement
// amounts (what each member PAID and what each member OWES, already resolved into
// SETTLEMENT-currency minor units by §7.6 and persisted on
// `transaction_payers.amount_paid_settlement` / `transaction_shares.amount_owed`),
// compute each member's NET balance:
//
//     balance(member) = Σ amount_paid_settlement(member) − Σ amount_owed(member)
//
//   - Positive → the member is owed money (creditor).
//   - Negative → the member owes money (debtor).
//   - Σ of all balances in the group == 0 (paid and owed each sum to the same
//     per-transaction settlement total, §7.6, so the group nets to zero).
//
// ── Why this lives in `src/lib/transactions/` (NOT `$lib/server`) ─────────────
// Same rationale as the sibling `resolve.ts`: a PURE, DB-free, side-effect-free
// money-math module that the server wrapper (`$lib/server/balances`) calls AND
// that the client could import for a live balance preview without pulling in
// `$lib/server` (which SvelteKit forbids on the client). All it does is sum
// integers — no IO, no floats.
//
// ── Scope (task 5.1) ──────────────────────────────────────────────────────────
// ONLY the net balance per member. The downstream §8 steps are SEPARATE tasks and
// are deliberately NOT here:
//   - §8.2 "who should pay" ordering                → task 5.2.
//   - §8.3 greedy debt simplification               → task 5.3.
//   - §8.4 settle UI / prefilled transfer           → task 5.4.

/**
 * The per-member settlement amounts feeding the balance math, keyed by member id.
 * Both maps are in SETTLEMENT-currency minor units (the §7.6 resolved values):
 *   - `paidByMember`  — Σ `amount_paid_settlement` for the member across the
 *     group's non-deleted transactions.
 *   - `owedByMember`  — Σ `amount_owed` for the member across the same.
 * A member absent from a map contributes 0 on that side. The maps need not cover
 * every member — `memberIds` is the authoritative roster (see below).
 */
export interface BalanceInputs {
	/** Σ settlement paid per member id (minor units). Missing key → paid 0. */
	readonly paidByMember: ReadonlyMap<string, number>;
	/** Σ settlement owed per member id (minor units). Missing key → owed 0. */
	readonly owedByMember: ReadonlyMap<string, number>;
	/**
	 * The group's member roster — EVERY member that must appear in the result,
	 * including those who neither paid nor owed (they get a 0 balance). This is the
	 * authoritative set: a member id that only shows up in the maps but not here is
	 * still included (defensively), but every id here is guaranteed present.
	 */
	readonly memberIds: readonly string[];
}

/**
 * One member's net balance (PLAN §8.1), in SETTLEMENT-currency minor units.
 */
export interface MemberBalance {
	readonly memberId: string;
	/**
	 * Σ paid − Σ owed, integer minor units. Positive → creditor (owed money),
	 * negative → debtor (owes money), 0 → square.
	 */
	readonly balance: number;
}

/**
 * Compute each member's net balance (PLAN §8.1) from the group's per-member
 * settlement paid/owed amounts. PURE: no DB, no IO, integer math only.
 *
 * Every id in `memberIds` appears in the output (a member who neither paid nor
 * owed gets balance 0). Any member id present only in the paid/owed maps is also
 * included so a stray amount can never silently vanish from the zero-sum.
 *
 * The result order is: `memberIds` in their given order first, then any extra
 * map-only ids in ascending order (deterministic for callers/tests). The
 * balances are guaranteed to sum to EXACTLY 0 when Σ paid == Σ owed across the
 * group (which §7.6 enforces per transaction).
 */
export function computeBalances({
	paidByMember,
	owedByMember,
	memberIds
}: BalanceInputs): MemberBalance[] {
	// The full set of member ids to report: the roster, plus any id that appears
	// in either map but isn't on the roster (defensive — never drop an amount).
	const seen = new Set<string>(memberIds);
	const extra: string[] = [];
	for (const id of paidByMember.keys()) {
		if (!seen.has(id)) {
			seen.add(id);
			extra.push(id);
		}
	}
	for (const id of owedByMember.keys()) {
		if (!seen.has(id)) {
			seen.add(id);
			extra.push(id);
		}
	}
	extra.sort();

	const ids = [...memberIds, ...extra];
	return ids.map((memberId) => ({
		memberId,
		// Integer minor units throughout — paid and owed are already settlement
		// minor units, so this subtraction is exact (no floats).
		balance: (paidByMember.get(memberId) ?? 0) - (owedByMember.get(memberId) ?? 0)
	}));
}
