// Shared Bearer-key verification (PLAN §16.3; ADR-0001, ADR-0007).
//
// The ONE place that turns an `Authorization: Bearer <key>` header into a
// resolved {@link ApiKeyPrincipal}. It was born inside `hooks.server.ts`'s
// `/api/v1` guard; the MCP Connector (`/mcp`, ADR-0001) needs the SAME
// verification but a DIFFERENT failure response (a `401` carrying
// `WWW-Authenticate: Bearer resource_metadata="…"` — ADR-0009), so the logic
// lives here and each transport owns only its response shape:
//
//   - `/api/v1`  → `hooks.server.ts#apiV1Guard`  → the generic 401 envelope.
//   - `/mcp`     → `lib/server/mcp/auth.ts`      → 401 + `WWW-Authenticate`.
//
// The outcome is a DISCRIMINATED UNION, not a `Response`, precisely so the two
// transports cannot drift on *what happened* while differing on *how they say it*.
// Every non-rate-limit failure collapses to ONE `unauthorized` reason: the
// plugin's internal error code (`INVALID_API_KEY`, `KEY_DISABLED`, `KEY_EXPIRED`,
// `KEY_NOT_FOUND`) is deliberately NEVER forwarded, so no caller can build an
// enumeration oracle out of it (PLAN §16.5).

import { auth } from '$lib/server/auth';
import type { ApiKeyPrincipal } from './principal';

/**
 * Extract the raw API key from an `Authorization: Bearer <key>` header.
 *
 * PURE and unit-testable. Returns the key with the `Bearer ` scheme stripped, or
 * `null` when the header is missing or malformed (no scheme, wrong scheme, or an
 * empty credential). The scheme match is case-insensitive per RFC 7235; the raw
 * key is passed straight to `verifyApiKey` (which reads no headers, so the
 * plugin's `x-api-key` default is bypassed — PLAN §16.3).
 */
export function extractBearerKey(authorization: string | null | undefined): string | null {
	if (!authorization) return null;
	const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
	if (!match) return null;
	const key = match[1].trim();
	return key.length > 0 ? key : null;
}

/**
 * The outcome of verifying a Bearer key.
 *
 *   - `ok` — a verified key; `principal` is the minimal identity (PLAN §16.4).
 *   - `unauthorized` — missing / malformed / invalid / expired / revoked, ALL
 *     collapsed to this single reason (no enumeration signal).
 *   - `rate_limited` — the plugin's TIER-1 per-key backstop tripped (PLAN §16.7).
 *     The only non-valid outcome that is not collapsed: rate limiting engages only
 *     AFTER a successful key match, so surfacing it leaks nothing. `tryAgainInMs`
 *     is the plugin's remaining budget (0 when it didn't say).
 */
export type BearerVerification =
	| { ok: true; principal: ApiKeyPrincipal }
	| { ok: false; reason: 'unauthorized' }
	| { ok: false; reason: 'rate_limited'; tryAgainInMs: number };

/**
 * Verify an `Authorization` header value against the api-key table.
 *
 * A thrown `verifyApiKey` (e.g. a DB blip) is treated as an auth failure, not a
 * 500: the caller gets `unauthorized` and nothing internal leaks. On success the
 * plugin's `referenceId` (the owning user) is surfaced as `userId`, and
 * `permissions` is carried through for the §16.2 scope guard / ADR-0002 tool
 * filtering.
 */
export async function verifyBearerKey(
	authorization: string | null | undefined
): Promise<BearerVerification> {
	const key = extractBearerKey(authorization);
	if (!key) return { ok: false, reason: 'unauthorized' };

	let result: Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
	try {
		result = await auth.api.verifyApiKey({ body: { key } });
	} catch (error) {
		console.error('[api/verify] verifyApiKey threw', error);
		return { ok: false, reason: 'unauthorized' };
	}

	if (!result.valid && result.error?.code === 'RATE_LIMITED') {
		const raw = (result.error as { details?: { tryAgainIn?: unknown } }).details?.tryAgainIn;
		return {
			ok: false,
			reason: 'rate_limited',
			tryAgainInMs: typeof raw === 'number' && raw > 0 ? raw : 0
		};
	}

	if (!result.valid || !result.key) {
		return { ok: false, reason: 'unauthorized' };
	}

	const principal: ApiKeyPrincipal = {
		keyId: result.key.id,
		name: result.key.name ?? null,
		userId: result.key.referenceId,
		permissions: result.key.permissions ?? null
	};
	return { ok: true, principal };
}
