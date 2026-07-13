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
import {
	getTransactionDetail,
	updateTransaction,
	softDeleteTransaction
} from '$lib/server/transactions';
import { toTransactionDetailDto } from '$lib/server/api/v1';
import { withReadErrorHandling } from '$lib/server/api/read';
import { withWriteErrorHandling, parseJsonBody } from '$lib/server/api/write';
import { requireWriteScope } from '$lib/server/api/scope';
import { auditVia } from '$lib/server/api/provenance';
import { requireRateLimit } from '$lib/server/api/rate-limit';
import { notFound, unauthorized } from '$lib/server/api/errors';

export const GET = withReadErrorHandling(async ({ locals, params }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();

	const { gid, txid } = params;
	if (!gid || !txid) return notFound();

	// TIER-2 read limiter (§16.7): 100/60s per key, enforced AFTER auth (the hook).
	const limited = await requireRateLimit(principal, 'read');
	if (limited) return limited;

	// Throws GroupAccessError / TransactionNotFoundError (→ 404) — mapped by the wrapper.
	const detail = await getTransactionDetail({
		userId: principal.userId,
		groupId: gid,
		txnId: txid
	});
	return json(toTransactionDetailDto(detail));
});

// PUT /api/v1/groups/{gid}/transactions/{txid} — FULL REPLACE of a transaction
// (PLAN §16.4: PUT, not PATCH — the body is the COMPLETE `TransactionInput`). A
// WRITE endpoint: scope guard FIRST (read key → 403). `updateTransaction`
// re-validates the whole input server-side (§7.6 `amountTotalSettlement` mismatch →
// 422 via the wrapper), refuses a soft-deleted txn (TransactionDeletedError → 422
// "restore first"), and 404s an absent / other-group id (conflated). On success we
// re-read the persisted detail and return the `TransactionDetail` DTO, 200.
export const PUT = withWriteErrorHandling(async ({ locals, params, request }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();
	const denied = requireWriteScope(principal);
	if (denied) return denied;

	const { gid, txid } = params;
	if (!gid || !txid) return notFound();

	// TIER-2 write limiter (§16.7): 20/60s per key, AFTER the scope guard so a read
	// key gets 403 (not 429) and never consumes this counter.
	const limited = await requireRateLimit(principal, 'write');
	if (limited) return limited;

	// Unparseable body → 400. The parsed value is the full internal input verbatim.
	const input = await parseJsonBody(request);

	// Throws TransactionValidationError (→ 422), TransactionDeletedError (→ 422),
	// GroupAccessError / TransactionNotFoundError (→ 404) — all mapped by the wrapper.
	await updateTransaction({
		userId: principal.userId,
		groupId: gid,
		txnId: txid,
		input,
		actorUserId: principal.userId,
		// §16.2 audit provenance: actor stays the user; the key is recorded as
		// `{viaKey,keyName}` metadata + a "(via API key '…')" summary suffix.
		via: auditVia(principal)
	});

	const detail = await getTransactionDetail({
		userId: principal.userId,
		groupId: gid,
		txnId: txid
	});
	return json(toTransactionDetailDto(detail));
});

// DELETE /api/v1/groups/{gid}/transactions/{txid} — SOFT delete (PLAN §16.4, §9).
// A WRITE endpoint: scope guard FIRST. `softDeleteTransaction` is IDEMPOTENT (a
// no-op on an already-deleted txn) and 404s an absent / other-group id. We return
// the still-served detail with `deletedAt` now set (200), so the caller sees the
// resulting state (§16.4 response table).
export const DELETE = withWriteErrorHandling(async ({ locals, params }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();
	const denied = requireWriteScope(principal);
	if (denied) return denied;

	const { gid, txid } = params;
	if (!gid || !txid) return notFound();

	// TIER-2 write limiter (§16.7): 20/60s per key, AFTER the scope guard so a read
	// key gets 403 (not 429) and never consumes this counter.
	const limited = await requireRateLimit(principal, 'write');
	if (limited) return limited;

	// Throws GroupAccessError / TransactionNotFoundError (→ 404) — mapped by the wrapper.
	await softDeleteTransaction({
		userId: principal.userId,
		groupId: gid,
		txnId: txid,
		actorUserId: principal.userId,
		// §16.2 audit provenance (only recorded when the delete actually transitions state).
		via: auditVia(principal)
	});

	const detail = await getTransactionDetail({
		userId: principal.userId,
		groupId: gid,
		txnId: txid
	});
	return json(toTransactionDetailDto(detail));
});
