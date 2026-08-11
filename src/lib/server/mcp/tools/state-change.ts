// The shared flow behind `delete_transaction` and `restore_transaction`.
//
// The two tools are mirror images: each flips ONE nullable column with a guarded
// UPDATE, and each has to tell the user what the ledger now holds AND whether this
// particular call transitioned anything. Everything except the service call and the
// prose lives here, so the pair cannot drift on the parts that carry the guarantees.
//
// ── Why the BEFORE state is read at all ──────────────────────────────────────
// For ONE fact the after-state cannot supply: was the transaction already in the
// target state? `deleted_at` reads the same either way once the service returns, so
// without this read a no-op and a real transition are indistinguishable — and the
// echo would narrate an action that never happened (§16.6: a no-op is an idempotent
// SUCCESS that transitions nothing and writes no audit row).
//
// It is also the access + existence gate on the TXN: access-checked and group-scoped,
// `getTransactionDetail` throws `TransactionNotFoundError` for an absent id, an id in
// another group, and an id the caller cannot see alike → the SAME conflated
// `not_found` as an unseeable group (§16.5). It deliberately still returns a
// SOFT-DELETED txn, which is what makes the restore path reachable at all.
//
// This is a read-then-act, and deliberately not more than that: two concurrent calls
// could both read the same before-state and both narrate a fresh transition. That
// costs a word of prose accuracy and NOTHING else — the DATA cannot double-apply (the
// services' `isNull`/`isNotNull` guards are atomic) and the audit trail still records
// exactly one row (its write is gated on rows-affected > 0, §16.6). Making the read
// authoritative would mean the shared service returning its rows-affected count — a
// change to a service REST also uses, for a cosmetic gain on a race that needs two
// concurrent calls on the same txn from the same key.
//
// ── Why the AFTER state is re-read ───────────────────────────────────────────
// So the echo describes what the ledger actually holds rather than what we asked for.
// A soft-deleted transaction stays fully readable, which is what makes restoring it
// possible and what lets the delete echo name what left the ledger. The entry currency
// is resolved on that read like every other read: a transaction recorded in a currency
// the GROUP defined can be deleted or restored through the assistant even though it
// could never have been WRITTEN through it (ADR-0014 decision 7).

import { getTransactionDetail } from '$lib/server/transactions';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import { toTransactionView, type MemberView, type TransactionView } from '../view';
import { loadEntryCurrency, loadGroupView, loadMemberViews } from './load';

export interface TransactionStateChange {
	/** The roster, for the echo's (untrusted) names + `isYou`. */
	readonly members: MemberView[];
	/** Whether the txn was ALREADY soft-deleted before this call ran. */
	readonly wasDeleted: boolean;
	/** The persisted post-call state, wrapped for the agent (ADR-0003). */
	readonly view: TransactionView;
	/** The persisted settlement total, for the echo's minor-unit restatement. */
	readonly minorUnits: number;
}

/**
 * Gate on the group, read the before-state, run `apply`, then project the persisted
 * after-state. `apply` is the tool's own guarded service call (`softDeleteTransaction`
 * / `restoreTransaction`), which writes its audit row with the key's provenance in the
 * same DB transaction as the flip (§12.1) — this helper never writes audit itself.
 */
export async function applyTransactionStateChange(
	principal: ApiKeyPrincipal,
	groupId: string,
	txnId: string,
	apply: () => Promise<void>
): Promise<TransactionStateChange> {
	// Access-checked load of the group. `loadGroupView` centralizes the conflated
	// `not_found` (absent / deleted / not-yours → ONE outcome, no existence oracle,
	// §16.5), so both write paths inherit it by construction.
	await loadGroupView(principal, groupId);
	const members = await loadMemberViews(principal, groupId);

	const before = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
	const wasDeleted = before.deletedAt !== null;

	await apply();

	const detail = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
	const entryCurrency = await loadEntryCurrency(groupId, detail.currency);
	return {
		members,
		wasDeleted,
		view: toTransactionView({ detail, members, principal, entryCurrency }),
		minorUnits: detail.amountTotalSettlement
	};
}
