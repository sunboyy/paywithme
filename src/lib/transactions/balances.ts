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

/**
 * "Who should pay" ordering (PLAN §8.2): sort members by net balance ASCENDING so
 * the MOST NEGATIVE balance (the largest debtor — who owes the most) comes first,
 * and creditors (positive balances) come last. The §8.4 settle UI surfaces this
 * order prominently; this is just the pure ordering primitive.
 *
 * PURE: no DB, no IO, integer math only. Does NOT mutate the input — returns a new
 * sorted array (the caller may pass a frozen/read-only array safely).
 *
 * Ties (equal balance) are broken by `memberId` ASCENDING, matching the codebase's
 * existing ascending-`member_id` tie-break (see `distribute` in `$lib/money`).
 * `memberId` is a string here, so a plain lexical compare is the well-defined
 * ascending order; this makes the result fully deterministic — two members with the
 * same balance always come out in the same order regardless of input order.
 */
export function orderByWhoShouldPay(balances: readonly MemberBalance[]): MemberBalance[] {
	// Copy first, then sort — never mutate the caller's array.
	return [...balances].sort((a, b) => {
		// Integer minor-unit subtraction → ascending by balance (most negative first).
		if (a.balance !== b.balance) {
			return a.balance - b.balance;
		}
		// Deterministic tie-break: lower memberId first (ascending), as strings.
		return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
	});
}

/**
 * One suggested transfer in the simplified settlement set (PLAN §8.3): "from pays
 * to amount". All fields in SETTLEMENT-currency minor units; `amount` is always a
 * positive integer.
 */
export interface SettlementSuggestion {
	/** The debtor who pays (had a negative balance). */
	readonly fromMemberId: string;
	/** The creditor who receives (had a positive balance). */
	readonly toMemberId: string;
	/** Transfer amount, integer minor units, strictly > 0. */
	readonly amount: number;
}

/**
 * Simplified settlement suggestions (PLAN §8.3) — a MINIMAL set of transfers that
 * squares everyone up, NOT the raw pairwise debts. Greedy debt-simplification:
 *
 *   1. Split members into creditors (balance > 0) and debtors (balance < 0);
 *      members with balance 0 are ignored.
 *   2. Repeatedly match the LARGEST debtor with the LARGEST creditor and suggest a
 *      transfer of `min(|debtor|, creditor)`, reducing both sides by that amount.
 *   3. Continue until all balances are ~0.
 *
 * Each step zeroes at least one party (the smaller magnitude side, or both on an
 * exact match), so the result has at most `n_nonzero − 1` transfers.
 *
 * PURE: no DB, no IO, integer minor-unit math only (no floats). Does NOT mutate the
 * input array — it works on internal copies.
 *
 * DETERMINISM (critical — the §8.4 settle UI must be stable and tests reliable):
 * "largest debtor"/"largest creditor" ties (equal magnitude) are broken by
 * `memberId` ASCENDING, matching the codebase's ascending-`member_id` tie-break
 * (see `distribute` in `$lib/money` and `orderByWhoShouldPay` above). So the same
 * set of balances ALWAYS yields the same suggestion list regardless of input order.
 *
 * Because Σ balances == 0 (§8.1) and each transfer is `min(|debtor|, creditor)`,
 * applying every suggestion brings every member to exactly 0 (conservation).
 */
export function suggestSettlements(balances: readonly MemberBalance[]): SettlementSuggestion[] {
	// Mutable working copies of the non-zero sides. We track remaining magnitude as
	// a positive integer for both lists (debtors hold |balance|, creditors hold
	// balance). Sorting DESCENDING by remaining magnitude puts the "largest" first;
	// ties break on memberId ASCENDING so selection is fully deterministic.
	const byLargest = (a: Working, b: Working): number => {
		if (a.remaining !== b.remaining) {
			return b.remaining - a.remaining; // larger magnitude first (descending)
		}
		// Deterministic tie-break: lower memberId first (ascending), as strings.
		return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
	};

	const debtors: Working[] = balances
		.filter((b) => b.balance < 0)
		.map((b) => ({ memberId: b.memberId, remaining: -b.balance }))
		.sort(byLargest);
	const creditors: Working[] = balances
		.filter((b) => b.balance > 0)
		.map((b) => ({ memberId: b.memberId, remaining: b.balance }))
		.sort(byLargest);

	const suggestions: SettlementSuggestion[] = [];

	// Both lists are kept sorted largest-first; index 0 is always the current
	// largest debtor / creditor. We never re-sort because reducing the head can only
	// keep it <= its previous value, and the OTHER head is untouched — but to stay
	// correct under partial settlements we advance whichever side hit 0 and re-pick
	// the largest from the remainder. Re-sorting after each step keeps it simple and
	// provably matches the greedy spec; the lists are tiny (group members).
	while (debtors.length > 0 && creditors.length > 0) {
		const debtor = debtors[0];
		const creditor = creditors[0];

		// Transfer the smaller of the two remaining magnitudes (integer min — exact).
		const amount = Math.min(debtor.remaining, creditor.remaining);
		suggestions.push({
			fromMemberId: debtor.memberId,
			toMemberId: creditor.memberId,
			amount
		});

		debtor.remaining -= amount;
		creditor.remaining -= amount;

		// Drop any side that is now fully settled; otherwise re-establish largest-first
		// ordering for the side that carried a residual.
		if (debtor.remaining === 0) {
			debtors.shift();
		} else {
			debtors.sort(byLargest);
		}
		if (creditor.remaining === 0) {
			creditors.shift();
		} else {
			creditors.sort(byLargest);
		}
	}

	return suggestions;
}

/** Internal mutable accumulator for the greedy matching (positive remaining). */
interface Working {
	readonly memberId: string;
	remaining: number;
}
