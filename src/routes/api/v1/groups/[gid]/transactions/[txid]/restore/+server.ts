// POST /api/v1/groups/{gid}/transactions/{txid}/restore — un-delete a
// soft-deleted transaction (PLAN §16.4, §9).
//
// A WRITE endpoint: the §16.2 scope guard runs FIRST (a read key → 403
// `forbidden_scope`). `restoreTransaction` is IDEMPOTENT (a no-op on a live txn)
// and 404s an absent / other-group id (conflated, existence never leaks). On
// success we re-read the persisted detail — now with `deletedAt` back to null — and
// return the `TransactionDetail` DTO (200), so the caller sees the resulting state
// (§16.4 response table).

import { json } from '@sveltejs/kit';
import { getTransactionDetail, restoreTransaction } from '$lib/server/transactions';
import { toTransactionDetailDto } from '$lib/server/api/v1';
import { withWriteErrorHandling } from '$lib/server/api/write';
import { requireWriteScope } from '$lib/server/api/scope';
import { notFound, unauthorized } from '$lib/server/api/errors';

export const POST = withWriteErrorHandling(async ({ locals, params }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();
	// §16.2 write-guard FIRST: a read key can never mutate (→ 403).
	const denied = requireWriteScope(principal);
	if (denied) return denied;

	const { gid, txid } = params;
	if (!gid || !txid) return notFound();

	// Throws GroupAccessError / TransactionNotFoundError (→ 404) — mapped by the wrapper.
	await restoreTransaction({
		userId: principal.userId,
		groupId: gid,
		txnId: txid,
		actorUserId: principal.userId
	});

	const detail = await getTransactionDetail({
		userId: principal.userId,
		groupId: gid,
		txnId: txid
	});
	return json(toTransactionDetailDto(detail));
});
