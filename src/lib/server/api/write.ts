// Shared write-endpoint glue for `/api/v1` mutating handlers (PLAN §16.4, §16.5).
//
// The write routes (#19) call into the `lib/server` transaction services, which
// signal failure with DOMAIN error classes — NOT SvelteKit `HttpError`s. This is
// the write-side sibling of `read.ts`: the ONE place that translates those throws
// (plus an unparseable request body) into the stable §16.5 envelope, so no handler
// duplicates the mapping and the wire contract can't drift:
//
//   - `JsonBodyError` (raised by {@link parseJsonBody} on an unparseable body) →
//     400 `bad_request`. JSON is the only accepted transport (§16.3); a body that
//     doesn't parse is a malformed request, not a field-level validation failure.
//   - `TransactionValidationError` → 422 `validation_error` with FIELD-LEVEL
//     `details`. The service re-validates the whole input through the shared
//     `buildTransactionSchema` (which owns the §7.6 `amountTotalSettlement`
//     equality rule), so a caller-supplied settlement mismatch surfaces here as a
//     422 whose `details.fieldErrors.amountTotalSettlement` names the offending
//     field — exactly what an agent needs to self-correct.
//   - `TransactionDeletedError` → 422 `validation_error`. A soft-deleted txn is
//     still VISIBLE via GET (so it can be restored), so a 404 here would be
//     inconsistent; it is a state-rule rejection ("restore it first"), surfaced
//     with the domain message and no field-level details.
//   - `GroupAccessError` / `TransactionNotFoundError` → 404 `not_found`, CONFLATED
//     with each other AND with "absent" (PLAN §16.5 / §12) so existence never leaks.
//   - `IdempotencyConflictError` → 409 `conflict` (§16.6) with `details.reason`
//     (`key_reused` = same key + different body; `in_progress` = a concurrent retry
//     lost the pending-first race).
//
// Anything else falls through to `handleApiError` (redirect re-throw / HttpError
// mapping / opaque 500). Wrapping a write handler in `withWriteErrorHandling` gives
// it the full 400 / 404 / 422 / 500 envelope for free.

import type { RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { GroupAccessError } from '$lib/server/groups';
import {
	TransactionValidationError,
	TransactionDeletedError,
	TransactionNotFoundError
} from '$lib/server/transactions';
import {
	badRequest,
	handleApiError,
	notFound,
	validationError,
	apiError,
	conflict
} from './errors';
import { IdempotencyConflictError } from './idempotency';

/**
 * The request body could not be parsed as JSON. Raised by {@link parseJsonBody} so
 * an unparseable body maps to a single 400 `bad_request` (§16.3/§16.5) rather than
 * collapsing to an opaque 500. A dedicated class (vs catching a bare `SyntaxError`)
 * keeps the mapping intentional — only OUR parse failure is a 400.
 */
export class JsonBodyError extends Error {
	readonly code = 'json_body_invalid' as const;
	constructor(message = 'The request body is not valid JSON') {
		super(message);
		this.name = 'JsonBodyError';
	}
}

/**
 * Parse a request's JSON body, raising {@link JsonBodyError} (→ 400) on anything
 * unparseable. Use in write handlers instead of a bare `request.json()` so the
 * wrapper maps a malformed body to the §16.5 `bad_request` envelope.
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new JsonBodyError();
	}
}

/**
 * Read a request's body ONCE as raw text AND parse it as JSON, raising
 * {@link JsonBodyError} (→ 400) on anything unparseable. The raw string is returned
 * alongside the parsed value so an idempotency handler can fingerprint the EXACT
 * bytes the client sent (§16.6) without re-reading the already-consumed body — a
 * `Request` body stream can only be read once.
 */
export async function readRawJsonBody(request: Request): Promise<{ raw: string; value: unknown }> {
	const raw = await request.text();
	try {
		return { raw, value: JSON.parse(raw) };
	} catch {
		throw new JsonBodyError();
	}
}

/**
 * Translate a value thrown by a `lib/server` write service (or {@link parseJsonBody})
 * into the stable §16.5 envelope `Response`. Known domain errors map to their
 * documented status; every other value is delegated to {@link handleApiError}
 * (redirect re-throw / HttpError mapping / opaque 500). PURE aside from that
 * delegation — unit-testable directly.
 */
export function mapWriteError(err: unknown): Response {
	// Unparseable request body → 400 (the only accepted transport is JSON, §16.3).
	if (err instanceof JsonBodyError) {
		return badRequest('The request body is not valid JSON.');
	}
	// A shared-schema rule failed → 422 with FIELD-LEVEL details (§16.5). Rebuild a
	// ZodError from the carried issues so `validationError` flattens it to
	// `{ formErrors, fieldErrors }` — e.g. an `amountTotalSettlement` mismatch (§7.6)
	// names that field so the caller can self-correct.
	if (err instanceof TransactionValidationError) {
		return validationError(new z.ZodError(err.issues));
	}
	// Editing a soft-deleted txn is a state-rule rejection, not a not-found (the txn
	// is still visible via GET). Surface the domain message as a 422 (§16.5).
	if (err instanceof TransactionDeletedError) {
		return apiError('validation_error', err.message);
	}
	// No access / not found / absent — deliberately CONFLATED to one 404 so existence
	// never leaks (PLAN §16.5 / §12).
	if (err instanceof GroupAccessError || err instanceof TransactionNotFoundError) {
		return notFound();
	}
	// An idempotency conflict (§16.6) → 409 `conflict`. `details.reason` names the
	// sub-case (`key_reused` = same key + different body; `in_progress` = a concurrent
	// retry lost the pending-first race) while the top-level `code` stays `conflict`.
	if (err instanceof IdempotencyConflictError) {
		return conflict(err.message, { reason: err.reason });
	}
	// Unknown: let the shared normalizer decide (re-throws redirects, maps HttpErrors,
	// collapses everything else to an opaque 500).
	return handleApiError(err);
}

/**
 * Wrap a write handler so any thrown value becomes the correct envelope via
 * {@link mapWriteError}. Write routes export `POST/PUT/DELETE = withWriteErrorHandling(
 * async (event) => …)`, giving them the 400/404/422/500 envelope for free while
 * control-flow `redirect()` still propagates (through `handleApiError`).
 */
export function withWriteErrorHandling(handler: RequestHandler): RequestHandler {
	return async (event) => {
		try {
			return await handler(event);
		} catch (err) {
			return mapWriteError(err);
		}
	};
}
