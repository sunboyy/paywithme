// The shared flow behind `delete_transaction` and `restore_transaction`.
//
// The two tools are mirror images: each flips ONE nullable column with a guarded
// UPDATE, and each has to tell the user what the ledger now holds AND whether this
// particular call transitioned anything. Everything except the service call and the
// prose lives here, so the pair cannot drift on the parts that carry the guarantees.
//
// The service answers both from inside its own transaction: `changed` is its
// rows-affected count (a no-op is an idempotent SUCCESS that transitions nothing and
// writes no audit row, §16.6), and `detail` is the persisted result. It also gates
// the TXN: an absent id, an id in another group, and an id the caller cannot see all
// throw the same conflated `not_found` as an unseeable group (§16.5). A soft-deleted
// transaction stays fully readable, which is what lets the delete echo name what left
// the ledger. The entry currency is resolved like on every other read: a transaction
// recorded in a currency the GROUP defined can be deleted or restored through the
// assistant even though it could never have been WRITTEN through it (ADR-0014
// decision 7).

import type { TransactionStateChange as ServiceStateChange } from '$lib/server/transactions';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import { toTransactionView, type MemberView, type TransactionView } from '../view';
import { loadEntryCurrency, loadGroupView, loadMemberViews } from './load';

export interface TransactionStateChange {
	/** The roster, for the echo's (untrusted) names + `isYou`. */
	readonly members: MemberView[];
	/** Whether this call transitioned anything; `false` means it was already in that state. */
	readonly changed: boolean;
	/** The persisted post-call state, wrapped for the agent (ADR-0003). */
	readonly view: TransactionView;
	/** The persisted settlement total, for the echo's minor-unit restatement. */
	readonly minorUnits: number;
}

/**
 * Gate on the group, run `apply`, then project the persisted result. `apply` is the
 * tool's own guarded service call (`softDeleteTransaction` / `restoreTransaction`),
 * which writes its audit row with the key's provenance in the same DB transaction as
 * the flip (§12.1) — this helper never writes audit itself.
 */
export async function applyTransactionStateChange(
	principal: ApiKeyPrincipal,
	groupId: string,
	apply: () => Promise<ServiceStateChange>
): Promise<TransactionStateChange> {
	await loadGroupView(principal, groupId);
	const members = await loadMemberViews(principal, groupId);

	const { changed, detail } = await apply();

	const entryCurrency = await loadEntryCurrency(groupId, detail.currency);
	return {
		members,
		changed,
		view: toTransactionView({ detail, members, principal, entryCurrency }),
		minorUnits: detail.amountTotalSettlement
	};
}
