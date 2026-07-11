// GET /api/v1/groups/{gid}/transactions/{txid} — one transaction's full detail
// (PLAN §16.4, §7.1/§7.2/§7.6/§9).
//
// `getTransactionDetail` is access-checked AND scoped to the group: it throws
// `GroupAccessError` (no access) or `TransactionNotFoundError` (absent / in
// another group) — BOTH translated by `withReadErrorHandling` to the CONFLATED
// 404 `not_found`, so a txn the caller can't see is indistinguishable from one
// that doesn't exist (PLAN §16.5 / §12). The detail is projected through
// `toTransactionDetailDto`, which DROPS the internal `input` edit-form seed and
// nests every amount as self-describing money. A soft-deleted txn is still served
// (marked via `deletedAt`). Any valid key suffices (an `R` endpoint).

import { json } from '@sveltejs/kit';
import { getTransactionDetail } from '$lib/server/transactions';
import { toTransactionDetailDto } from '$lib/server/api/v1';
import { withReadErrorHandling } from '$lib/server/api/read';
import { notFound, unauthorized } from '$lib/server/api/errors';

export const GET = withReadErrorHandling(async ({ locals, params }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();

	const { gid, txid } = params;
	if (!gid || !txid) return notFound();

	// Throws GroupAccessError / TransactionNotFoundError (→ 404) — mapped by the wrapper.
	const detail = await getTransactionDetail({
		userId: principal.userId,
		groupId: gid,
		txnId: txid
	});
	return json(toTransactionDetailDto(detail));
});
