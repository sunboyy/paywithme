// Shared read-endpoint glue for `/api/v1` GET handlers (PLAN §16.4, §16.5).
//
// The read routes (#18) all call into the `lib/server` read services, which
// signal failure with DOMAIN error classes — NOT SvelteKit `HttpError`s:
//
//   - `GroupAccessError`        (no access / soft-deleted / absent group)
//   - `TransactionNotFoundError`(txn absent / in another group)
//   - `TransactionCursorError`  (an undecodable pagination cursor)
//
// `withApiErrorHandling` (errors.ts) only maps SvelteKit `HttpError`s, so these
// domain throws would otherwise collapse to a generic 500. This module is the ONE
// place that translates them into the stable §16.5 envelope, so no handler
// duplicates the mapping and the wire contract can't drift:
//
//   - `GroupAccessError` / `TransactionNotFoundError` → 404 `not_found`. The two
//     are CONFLATED with each other AND with "absent" (PLAN §16.5 / §12) so an
//     id-probing agent can never tell "you can't see it" from "it doesn't exist".
//   - `TransactionCursorError` → 400 `bad_request`. A cursor is an OPAQUE blob the
//     client got from us; an undecodable one is a malformed token, not a
//     field-level validation failure — so 400 (unparseable), not 422. Crucially it
//     is neither swallowed (which would silently restart pagination from page 1)
//     nor 500 (which would hide a real client bug). Structured query params
//     (`limit`, `from`/`to`) are validated separately by the handler's Zod schema
//     and surface as 422 `validation_error`; the two are consistently split.
//
// Anything else falls through to `handleApiError`, which re-throws control-flow
// `redirect()`s, maps `HttpError`s by status, and collapses the rest to an opaque
// 500 — so wrapping a read handler in `withReadErrorHandling` gives it the full
// 404 / 400 / 500 envelope for free.

import type { RequestHandler } from '@sveltejs/kit';
import { GroupAccessError } from '$lib/server/groups';
import { TransactionNotFoundError, TransactionCursorError } from '$lib/server/transactions';
import { badRequest, handleApiError, notFound } from './errors';

/**
 * Translate a value thrown by a `lib/server` read service into the stable §16.5
 * envelope `Response`. Known domain errors map to their documented status; every
 * other value is delegated to {@link handleApiError} (redirect re-throw / HttpError
 * mapping / opaque 500). PURE aside from that delegation — unit-tested directly.
 */
export function mapReadError(err: unknown): Response {
	// No access / not found / absent — deliberately CONFLATED to one 404 so
	// existence never leaks (PLAN §16.5 / §12).
	if (err instanceof GroupAccessError || err instanceof TransactionNotFoundError) {
		return notFound();
	}
	// A malformed opaque pagination cursor — a client error, never silently ignored.
	if (err instanceof TransactionCursorError) {
		return badRequest('The pagination cursor is invalid.');
	}
	// Unknown: let the shared normalizer decide (re-throws redirects, maps
	// HttpErrors, collapses everything else to an opaque 500).
	return handleApiError(err);
}

/**
 * Wrap a read handler so any thrown value becomes the correct envelope via
 * {@link mapReadError}. Read routes export `GET = withReadErrorHandling(async
 * (event) => …)`, giving them the 404/400/500 envelope for free while control-flow
 * `redirect()` still propagates (through `handleApiError`).
 */
export function withReadErrorHandling(handler: RequestHandler): RequestHandler {
	return async (event) => {
		try {
			return await handler(event);
		} catch (err) {
			return mapReadError(err);
		}
	};
}
