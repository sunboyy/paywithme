// Shared `/api/v1` error envelope + 500 normalizer seam (PLAN §16.5, §16.3).
//
// Every public-API error is emitted as the SAME stable JSON envelope
// (PLAN §16.5):
//
//   { "error": { "code": <stable string>, "message": <human>, "details"?: <structured> } }
//
// This module is the ONE source of truth for that shape. Route handlers
// (#17–#19), the catch-all 404 route, the scope write-guard (`scope.ts`), and the
// 500 normalizer all build responses through here so the wire contract never
// drifts. The `code` strings are a documented, stable API surface — an agent keys
// off them to self-correct — so they live as constants and never change casually.
//
// The #14 auth hook still emits its 401 inline (`hooks.server.ts#unauthorized`);
// that shape is byte-identical to `apiError('unauthorized')` here. A future,
// low-risk cleanup can swap the hook to call this helper — see the note there.
// This ticket deliberately leaves the hook untouched to stay focused.

import { json, isHttpError, isRedirect, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';

/**
 * The stable error codes (PLAN §16.5). Each maps 1:1 to an HTTP status via
 * `STATUS_BY_CODE`. These strings are part of the public API contract — agents
 * branch on them — so they are frozen constants, never inlined ad-hoc.
 */
export const API_ERROR_CODES = {
	/** 400 — the request body/params could not be parsed. */
	bad_request: 'bad_request',
	/** 401 — missing / invalid / expired / revoked key. Emitted by the auth hook. */
	unauthorized: 'unauthorized',
	/** 403 — a `read` key attempted a write (the §16.2 scope guard). */
	forbidden_scope: 'forbidden_scope',
	/** 404 — absent OR no-access, deliberately CONFLATED so existence never leaks. */
	not_found: 'not_found',
	/** 422 — a Zod rule failed; `details` carries field-level errors. */
	validation_error: 'validation_error',
	/** 429 — rate limit exceeded (wired by a later ticket, §16.7). */
	rate_limited: 'rate_limited',
	/**
	 * 409 — an idempotency conflict (§16.6). Emitted for BOTH "same `Idempotency-Key`
	 * + a DIFFERENT request body" (key reused) and "a concurrent retry is still in
	 * progress" (the pending-first insert lost the race). §16.5's enumerated list
	 * omits 409, but §16.6 requires it; `details.reason` (`key_reused` | `in_progress`)
	 * distinguishes the two sub-cases while the top-level `code` stays `conflict`.
	 */
	conflict: 'conflict',
	/** 500 — an uncaught internal error, normalized so no internals leak. */
	internal_error: 'internal_error'
} as const;

/** The union of stable error-code strings. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/** The HTTP status each code maps to (PLAN §16.5). */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden_scope: 403,
	not_found: 404,
	validation_error: 422,
	rate_limited: 429,
	conflict: 409,
	internal_error: 500
};

/**
 * A sensible default human message per code. Callers may override with a more
 * specific message; the code (not the prose) is the machine-readable contract.
 * The `unauthorized` default matches the #14 hook's inline 401 verbatim so the
 * two stay consistent.
 */
const DEFAULT_MESSAGE_BY_CODE: Record<ApiErrorCode, string> = {
	bad_request: 'The request could not be parsed.',
	unauthorized: 'Authentication required.',
	forbidden_scope: 'This API key does not have write access.',
	not_found: 'The requested resource was not found.',
	validation_error: 'The request failed validation.',
	rate_limited: 'Rate limit exceeded.',
	conflict: 'The request conflicts with the current state of the resource.',
	internal_error: 'Internal server error.'
};

/** The inner error object of the envelope. */
export interface ApiErrorDetail {
	code: ApiErrorCode;
	message: string;
	details?: unknown;
}

/** The full envelope: `{ error: { code, message, details? } }`. */
export interface ApiErrorEnvelope {
	error: ApiErrorDetail;
}

/**
 * Build the plain envelope OBJECT (no `Response`) for `code`. Used by the
 * `handleError` hook (which must return an `App.Error`, not a `Response`) and by
 * `apiError` below. `details` is included only when provided, so the `details?`
 * key is genuinely optional on the wire.
 */
export function apiErrorEnvelope(
	code: ApiErrorCode,
	message?: string,
	details?: unknown
): ApiErrorEnvelope {
	const detail: ApiErrorDetail = {
		code,
		message: message ?? DEFAULT_MESSAGE_BY_CODE[code]
	};
	if (details !== undefined) {
		detail.details = details;
	}
	return { error: detail };
}

/**
 * Build the JSON `Response` envelope for `code` with the correct HTTP status
 * (PLAN §16.5). This is the workhorse every route/guard uses. `application/json`
 * is set by SvelteKit's `json()` helper.
 */
export function apiError(code: ApiErrorCode, message?: string, details?: unknown): Response {
	return json(apiErrorEnvelope(code, message, details), { status: STATUS_BY_CODE[code] });
}

// --- Per-code convenience helpers -------------------------------------------
// Thin wrappers so call sites read intently (`notFound()` vs `apiError('not_found')`).

/** 400 `bad_request` — unparseable request. */
export const badRequest = (message?: string, details?: unknown): Response =>
	apiError('bad_request', message, details);

/** 401 `unauthorized` — missing/invalid/expired/revoked key. */
export const unauthorized = (message?: string): Response => apiError('unauthorized', message);

/** 403 `forbidden_scope` — a read key attempting a write (§16.2). */
export const forbiddenScope = (message?: string): Response => apiError('forbidden_scope', message);

/**
 * 404 `not_found` — absent OR no-access, deliberately CONFLATED (PLAN §16.5 /
 * §12): callers return this for BOTH "the resource does not exist" and "you have
 * no access to it" so an id-probing agent can never distinguish the two. This
 * mirrors the `access.ts` not-found discipline for the web app.
 */
export const notFound = (message?: string): Response => apiError('not_found', message);

/**
 * 429 `rate_limited` (PLAN §16.7). `details` carries the window context
 * (`{ scope, limit, windowSeconds, retryAfterSeconds }` for tier 2; a tier-1 shape
 * for the plugin backstop). When `retryAfterSeconds` is provided, the standard
 * `Retry-After: <seconds>` header is set ALONGSIDE the JSON envelope so a
 * well-behaved client can back off without parsing the body (§16.7). Omitting it
 * keeps the bare `rateLimited()` shape unchanged for existing callers/tests.
 */
export const rateLimited = (
	message?: string,
	details?: unknown,
	retryAfterSeconds?: number
): Response => {
	const res = apiError('rate_limited', message, details);
	if (retryAfterSeconds !== undefined) {
		res.headers.set('Retry-After', String(retryAfterSeconds));
	}
	return res;
};

/**
 * 409 `conflict` — an idempotency conflict (§16.6). Use `details.reason` to name
 * the sub-case: `key_reused` (same `Idempotency-Key`, different body) or
 * `in_progress` (a concurrent retry still running under the pending-first insert).
 * The top-level `code` stays `conflict` either way.
 */
export const conflict = (message?: string, details?: unknown): Response =>
	apiError('conflict', message, details);

/** 500 `internal_error` — normalized uncaught failure, no internals leaked. */
export const internalError = (message?: string): Response => apiError('internal_error', message);

/**
 * 422 `validation_error` with FIELD-LEVEL `details` (PLAN §16.5). Accepts either
 * a raw `ZodError` — flattened to `{ formErrors, fieldErrors }` so an agent can
 * see exactly which field failed and why — or a pre-built details object. The
 * structured `details` is the whole point of this code: it lets an agent
 * self-correct its request.
 */
export function validationError(source: z.ZodError | unknown, message?: string): Response {
	const details = source instanceof z.ZodError ? z.flattenError(source) : source;
	return apiError('validation_error', message, details);
}

/**
 * 500 normalizer seam (PLAN §16.3 "handleError-style seam"). Turns ANY thrown
 * value into the correct envelope `Response` WITHOUT leaking internals:
 *
 *   - a SvelteKit `redirect()` is re-thrown (never swallowed — control flow);
 *   - a SvelteKit `error(status, …)` (`HttpError`) maps by status to the matching
 *     envelope code (e.g. `error(404)` → `not_found`), reusing the thrown
 *     message when the plugin/handler chose one;
 *   - anything else is logged server-side and collapsed to a generic
 *     `internal_error` 500 — the original message is NEVER forwarded.
 *
 * Pair it with `withApiErrorHandling` (below) to wrap a route handler, or call it
 * directly in a `catch`. This is the reliable producer of the JSON 500 envelope
 * for API routes (they have no `+error` page — see the module note in
 * `hooks.server.ts` on why the `handleError` hook alone can't guarantee the JSON
 * body under content negotiation).
 */
export function handleApiError(err: unknown): Response {
	// Control-flow throws must propagate untouched.
	if (isRedirect(err)) {
		throw err;
	}

	if (isHttpError(err)) {
		const code = HTTP_STATUS_TO_CODE[err.status] ?? 'internal_error';
		// SvelteKit's HttpError body is `{ message }`; reuse it for the human field.
		const message = typeof err.body?.message === 'string' ? err.body.message : undefined;
		// A 500-class HttpError still must not leak an arbitrary message.
		return code === 'internal_error' ? internalError() : apiError(code, message);
	}

	// Genuinely uncaught: log for operators, return an opaque 500.
	console.error('[api/v1] uncaught error', err);
	return internalError();
}

/** Map an HTTP status thrown via `error()` back to the stable envelope code. */
const HTTP_STATUS_TO_CODE: Record<number, ApiErrorCode> = {
	400: 'bad_request',
	401: 'unauthorized',
	403: 'forbidden_scope',
	404: 'not_found',
	409: 'conflict',
	422: 'validation_error',
	429: 'rate_limited',
	500: 'internal_error'
};

/**
 * Wrap an `/api/v1` route handler so any thrown value becomes the correct
 * envelope via `handleApiError`. Future resource handlers (#17–#19) export
 * `GET = withApiErrorHandling(async (event) => …)`, giving them the 500/404/…
 * envelope for free while control-flow `redirect()` still propagates.
 */
export function withApiErrorHandling(handler: RequestHandler): RequestHandler {
	return async (event) => {
		try {
			return await handler(event);
		} catch (err) {
			return handleApiError(err);
		}
	};
}
