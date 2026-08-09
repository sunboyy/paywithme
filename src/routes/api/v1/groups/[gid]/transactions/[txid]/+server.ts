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
import { resolveEntryCurrency, resolveWriteCurrency } from '$lib/server/entry-currency';
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
	// Resolve the ENTRY currency so a transaction recorded in a currency the group
	// defined itself is served by its `display_code`, never by the opaque row key the
	// column stores (PLAN §7.5.2; ADR-0014 decision 7). Costs no query for the seeded 29.
	return json(toTransactionDetailDto(detail, await resolveEntryCurrency(gid, detail.currency)));
});

// PUT /api/v1/groups/{gid}/transactions/{txid} — FULL REPLACE of a transaction
// (PLAN §16.4: PUT, not PATCH — the body is the COMPLETE `TransactionInput`). A
// WRITE endpoint: scope guard FIRST (read key → 403). `updateTransaction`
// re-validates the whole input server-side (§7.6 `amountTotalSettlement` mismatch →
// 422 via the wrapper), refuses a soft-deleted txn (TransactionDeletedError → 422
// "restore first"), and 404s an absent / other-group id (conflated). On success we
// re-read the persisted detail and return the `TransactionDetail` DTO, 200.
//
// The body's `currency` is a DISPLAY code (§7.5.2 "REST surface"; ADR-0014 decision
// 8), translated to the internal currency key before the service runs. This is what
// makes the resource round-trip: the `currency` a GET served can be sent straight
// back, including for a transaction recorded in a currency the group defined itself
// — which a full-replacement PUT could not otherwise express, since the opaque key
// is never disclosed. Unresolvable → the ordinary entry-currency 422.
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

	// Unparseable body → 400. The parsed value is the full internal input verbatim,
	// save for the ONE documented substitution (§16.4): `currency` arrives as a
	// display code and is translated to the internal key against THIS group.
	const body = await parseJsonBody(request);
	const input = await resolveWriteCurrency(gid, body);

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
	// Resolve the ENTRY currency so a transaction recorded in a currency the group
	// defined itself is served by its `display_code`, never by the opaque row key the
	// column stores (PLAN §7.5.2; ADR-0014 decision 7). Costs no query for the seeded 29.
	return json(toTransactionDetailDto(detail, await resolveEntryCurrency(gid, detail.currency)));
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
	// Resolve the ENTRY currency so a transaction recorded in a currency the group
	// defined itself is served by its `display_code`, never by the opaque row key the
	// column stores (PLAN §7.5.2; ADR-0014 decision 7). Costs no query for the seeded 29.
	return json(toTransactionDetailDto(detail, await resolveEntryCurrency(gid, detail.currency)));
});
