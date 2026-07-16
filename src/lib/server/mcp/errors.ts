// The MCP error contract (ADR-0009) — TWO channels, deliberately split.
//
//   1. AUTH failures → the HTTP layer. `401` + `WWW-Authenticate: Bearer
//      resource_metadata="…"`. Claude does NOT honour `WWW-Authenticate` on a
//      `200`, and a missing `resource_metadata` pointer is the most common cause
//      of "Couldn't reach the MCP server" — so it ships from day one even though
//      Phase 1 is bearer-only (ADR-0007).
//
//   2. DOMAIN failures → `isError: true` TOOL RESULTS carrying the EXISTING
//      `/api/v1` envelope codes verbatim (`validation_error`, `forbidden_scope`,
//      `rate_limited`, `not_found`, …). The agent reads them as content and
//      self-corrects. A domain error must NEVER become a JSON-RPC protocol error:
//      the agent cannot reason about a broken transport and may retry blindly —
//      and a blind retry of a write is a duplicate transaction.
//
// Retry guidance is part of the message BY DESIGN (ADR-0009's table): the agent
// will invent its own policy otherwise. It is a PROMPT, not an enforcement — the
// idempotency window (§16.6) remains the actual protection against a retried write.
//
// ── 404 stays conflated ──────────────────────────────────────────────────────
// `GroupAccessError` ("not yours") and a genuinely absent id BOTH map to the SAME
// `not_found` body, byte-for-byte. Un-conflating them here would hand an agent an
// existence oracle — a security regression against the `/api/v1` contract we are
// reusing. `mapToolError` is where that invariant is enforced, and the unit tests
// assert the two are indistinguishable.

import { z } from 'zod';
import { apiErrorEnvelope, type ApiErrorCode } from '$lib/server/api/errors';
import { IdempotencyConflictError } from '$lib/server/api/idempotency';
import { GroupAccessError } from '$lib/server/groups';
import {
	TransactionCursorError,
	TransactionNotFoundError,
	TransactionValidationError
} from '$lib/server/transactions';
import type { McpToolResult } from './types';

/**
 * Where an unauthenticated client is told to look for OAuth metadata (RFC 9728).
 * The endpoint itself is the OAuth ticket's business (ADR-0007 defers the choice);
 * the POINTER costs nothing now and is exactly the handshake Claude needs if we go
 * that way.
 */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** Retry guidance appended to specific codes (ADR-0009's table). */
const RETRY_GUIDANCE: Partial<Record<ApiErrorCode, string>> = {
	forbidden_scope:
		'Do not retry. This key is read-only. Ask the user for a write key if they want this change made.',
	rate_limited:
		'Do NOT retry immediately. Wait for the retry window to elapse before trying again.',
	internal_error: 'Do not retry immediately. This is a server-side failure, not a bad request.'
};

/**
 * The `401` for a missing / invalid / expired / revoked key — the ONLY auth
 * response this endpoint emits, so it carries no enumeration signal (PLAN §16.5).
 * `origin` is the LIVE request origin, so the pointer is correct in dev, on a
 * preview deploy and in production without a hard-coded host.
 */
export function mcpUnauthorized(origin: string): Response {
	return new Response(JSON.stringify(apiErrorEnvelope('unauthorized')), {
		status: 401,
		headers: {
			'content-type': 'application/json',
			'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`
		}
	});
}

/**
 * A non-`POST` method. ADR-0001: `GET` MUST be either an SSE stream or a `405`,
 * and we have no server-initiated messages — so, `405`.
 */
export function mcpMethodNotAllowed(): Response {
	return new Response(
		JSON.stringify(
			apiErrorEnvelope('bad_request', 'The MCP endpoint accepts POST only (no SSE stream).')
		),
		{ status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } }
	);
}

/**
 * A rejected `Origin` — the DNS-rebinding defence (ADR-0001). A transport-level
 * refusal, not a tool result: there is no trustworthy caller to hand content to.
 */
export function mcpForbiddenOrigin(): Response {
	return new Response(
		JSON.stringify(apiErrorEnvelope('bad_request', 'The request Origin is not allowed.')),
		{ status: 403, headers: { 'content-type': 'application/json' } }
	);
}

/** The TIER-1 (per-key backstop) 429 — see `mcpRateLimitedResult` for the tier-2 path. */
export function mcpRateLimited(retryAfterSeconds: number): Response {
	return new Response(
		JSON.stringify(
			apiErrorEnvelope('rate_limited', 'Rate limit exceeded.', {
				scope: 'key',
				retryAfterSeconds
			})
		),
		{
			status: 429,
			headers: {
				'content-type': 'application/json',
				'retry-after': String(retryAfterSeconds)
			}
		}
	);
}

/**
 * Build an `isError: true` tool result from an envelope `code` (ADR-0009). The
 * content is the SAME `{ error: { code, message, details? } }` envelope `/api/v1`
 * returns — already machine-readable, already tested — serialized as text, plus
 * `structuredContent` for clients that read it. Retry guidance is appended to the
 * message where ADR-0009 calls for it.
 */
export function toolError(code: ApiErrorCode, message?: string, details?: unknown): McpToolResult {
	const envelope = apiErrorEnvelope(code, message, details);
	const guidance = RETRY_GUIDANCE[code];
	if (guidance) {
		envelope.error.message = `${envelope.error.message} ${guidance}`;
	}
	return {
		content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
		structuredContent: envelope as unknown as Record<string, unknown>,
		isError: true
	};
}

/** A successful tool result: the payload as pretty JSON text + structured content. */
export function toolSuccess(payload: Record<string, unknown>): McpToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload
	};
}

/** The 429 tool result for the tier-2 read/write limiter (ADR-0009: `rate_limited`). */
export function mcpRateLimitedResult(
	scope: 'read' | 'write',
	limit: number,
	windowSeconds: number,
	retryAfterSeconds: number
): McpToolResult {
	return toolError('rate_limited', 'Rate limit exceeded.', {
		scope,
		limit,
		windowSeconds,
		retryAfterSeconds
	});
}

/**
 * Translate a value THROWN by a `lib/server` service into an `isError` tool result.
 *
 * The mirror of `$lib/server/api/read.ts#mapReadError` — same domain classes, same
 * codes, different channel. Anything unrecognized is logged server-side and
 * collapsed to an opaque `internal_error`: it must not escape as a JSON-RPC
 * protocol error (ADR-0009's "the default of throw-and-let-it-become-a-protocol-error
 * is wrong"), and it must not leak internals.
 */
export function mapToolError(err: unknown): McpToolResult {
	// No access / absent — CONFLATED into one body so existence never leaks.
	if (err instanceof GroupAccessError || err instanceof TransactionNotFoundError) {
		return toolError('not_found');
	}
	if (err instanceof TransactionCursorError) {
		return toolError('bad_request', 'The pagination cursor is invalid.');
	}
	// An idempotency conflict raised by the server-derived window (ADR-0005). MCP has
	// no 409 to hand back, so — like every other domain failure (ADR-0009) — it becomes
	// an `isError` RESULT the agent can read and act on, mirroring REST's `mapWriteError`
	// shape (`code: 'conflict'` + `details.reason`) so the two channels agree.
	//
	// Both reasons MUST be mapped here even though only one is reachable: the derived
	// key encodes the arguments, so `key_reused` (same key, different body) cannot occur
	// on the MCP path. Leaving it unmapped would let a SHA-256 collision — or a future
	// caller that derives keys differently — surface to an agent as an opaque
	// `internal_error`, the one thing ADR-0009 forbids.
	if (err instanceof IdempotencyConflictError) {
		const message =
			err.reason === 'in_progress'
				? 'An identical create for this group is already in progress — most likely your own ' +
					'immediately preceding call, which has NOT failed. Nothing was lost and nothing was ' +
					'duplicated. Do NOT retry: wait a moment, then call `list_transactions` to confirm ' +
					'it landed before deciding to act.'
				: 'This write conflicts with one already recorded under the same idempotency key. Do ' +
					'not retry it unchanged; call `list_transactions` to see what is actually on the ledger.';
		return toolError('conflict', message, { reason: err.reason });
	}
	// The SHARED transaction schema rejecting server-side (a write tool re-validating an
	// unknown / other-group / DEACTIVATED member id, a category/type mismatch, a §7.6
	// settlement mismatch, …) — self-correctable, so it must be a `validation_error`, NOT
	// the opaque `internal_error` a plain `Error` would fall through to. The carried
	// `.issues` are the SAME Zod issue array the `ZodError` branch formats, so we rebuild a
	// `ZodError` and reuse that field-level shaping — mirroring REST's `mapWriteError`
	// (`api/write.ts`), so the two channels name the bad field identically.
	if (err instanceof TransactionValidationError) {
		return toolError('validation_error', undefined, z.flattenError(new z.ZodError(err.issues)));
	}
	// A tool's own Zod rules failing — self-correctable: `details` names the field.
	if (err instanceof z.ZodError) {
		return toolError('validation_error', undefined, z.flattenError(err));
	}
	console.error('[mcp] uncaught tool error', err);
	return toolError('internal_error');
}
