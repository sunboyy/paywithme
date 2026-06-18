// Group balances service — the §8.1 net-balance-per-member query (task 5.1).
// CLAUDE.md: "Business logic in lib/server/".
//
// This is the SERVER-SIDE wrapper around the PURE `computeBalances` core
// (`$lib/transactions/balances`). It loads the SETTLEMENT-currency per-member
// amounts for a group's NON-DELETED transactions and feeds them to the pure
// function, which does the integer math (Σ paid − Σ owed per member, §8.1).
//
// ── What it reads (the §7.6 resolved settlement columns ONLY) ─────────────────
// Per §8, all balance math runs in the group's settlement currency using the
// per-transaction settlement-converted amounts — foreign entry currency / rates
// are invisible here. So we sum:
//   - `transaction_payers.amount_paid_settlement` per member (what they PAID), and
//   - `transaction_shares.amount_owed` per member (already settlement-currency,
//     aggregated per member, what they OWE),
// over the group's transactions that are NOT soft-deleted (`transactions.deleted_at
// IS NULL`) — a deleted transaction must not affect balances (§9).
//
// ── Scope (task 5.1) ──────────────────────────────────────────────────────────
// ONLY net balance per member. §8.2 ordering (task 5.2), §8.3 simplification
// (task 5.3) and §8.4 settle UI (task 5.4) are SEPARATE later tasks.

import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { transactions, transactionPayers, transactionShares } from './db/transactions-schema';
import { members } from './db/groups-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { computeBalances, type MemberBalance } from '$lib/transactions/balances';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * Net balance per member for a group (PLAN §8.1), in SETTLEMENT-currency minor
 * units — access-checked. Loads each member's Σ settlement paid + Σ owed across
 * the group's NON-DELETED transactions and calls the pure {@link computeBalances}.
 *
 * Every ACTIVE (non-deactivated) member of the group is present in the result,
 * including those with a 0 balance (neither paid nor owed). The balances sum to
 * exactly 0 (§8.1). The result is ordered by ascending member id for determinism.
 *
 * @throws {GroupAccessError} (→404) when the user has no access to the group.
 */
export async function getGroupBalances({
	userId,
	groupId,
	executor = db
}: {
	userId: string;
	groupId: string;
	/** Optional executor (an open tx handle) so this can join a larger transaction. */
	executor?: DbExecutor;
}): Promise<MemberBalance[]> {
	if (!(await userHasGroupAccess(userId, groupId, executor))) {
		throw new GroupAccessError();
	}

	// The group's roster — ACTIVE (non-deactivated) members, ascending id. Every
	// one appears in the result, including zero-balance members (§8.1).
	const memberRows = await executor
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.groupId, groupId), isNull(members.deactivatedAt)));
	const memberIds = memberRows.map((m) => m.id).sort();

	// Σ settlement PAID per member, over the group's NON-DELETED transactions. Join
	// payers → transactions so we can scope to the group and exclude soft-deleted
	// rows (deleted_at IS NULL) — a deleted txn must not affect balances (§9).
	const paidRows = await executor
		.select({
			memberId: transactionPayers.memberId,
			amount: transactionPayers.amountPaidSettlement
		})
		.from(transactionPayers)
		.innerJoin(transactions, eq(transactionPayers.transactionId, transactions.id))
		.where(and(eq(transactions.groupId, groupId), isNull(transactions.deletedAt)));

	// Σ settlement OWED per member, over the same NON-DELETED transactions.
	// `transaction_shares.amount_owed` is already settlement-currency, aggregated
	// per member (§7.6 / §8 source of truth).
	const owedRows = await executor
		.select({
			memberId: transactionShares.memberId,
			amount: transactionShares.amountOwed
		})
		.from(transactionShares)
		.innerJoin(transactions, eq(transactionShares.transactionId, transactions.id))
		.where(and(eq(transactions.groupId, groupId), isNull(transactions.deletedAt)));

	// Aggregate in JS (integer adds, no floats) into per-member maps. We could push
	// the SUM/GROUP BY into SQL, but a group's ledger is small and summing here
	// keeps the pure core trivially testable and the query mock-friendly.
	const paidByMember = sumByMember(paidRows);
	const owedByMember = sumByMember(owedRows);

	return computeBalances({ paidByMember, owedByMember, memberIds });
}

/** Sum settlement minor-unit `amount` rows into a per-member-id map (integer adds). */
function sumByMember(rows: { memberId: string; amount: number }[]): Map<string, number> {
	const byMember = new Map<string, number>();
	for (const { memberId, amount } of rows) {
		byMember.set(memberId, (byMember.get(memberId) ?? 0) + amount);
	}
	return byMember;
}
