// `/mcp` auth resolution — dual credential, ONE principal (ADR-0010 §Decision(3)).
//
// The `/mcp` transport accepts EITHER an OAuth access token (Claude.ai's
// connector flow) OR an API key (how Claude Code / Cursor connect). This module
// is the ONE place that knows which credential arrived: it tries OAuth FIRST,
// falls back to the existing api-key verification, and converges BOTH on a single
// {@link ApiKeyPrincipal} so the tool/dispatch layer below the transport
// (ADR-0002, ADR-0006) never learns there are two credential kinds.
//
// `verify.ts` already promised this seam ("`/mcp` → `lib/server/mcp/auth.ts`"):
// it owns the SHARED key verification and the discriminated-union outcome; we own
// the OAuth-first resolution on top of it. The outcome type is verify.ts's
// {@link BearerVerification} verbatim, so `handler.ts` stays a thin consumer that
// cannot tell the two credential paths apart.
//
// ── Why OAuth first ──────────────────────────────────────────────────────────
// An api-key string is never stored in the `oauthAccessToken` table, so
// `getMcpSession` returns `null` for it and the key fallback runs — trying OAuth
// first therefore costs a lookup that misses, never a mis-auth. Crucially the key
// path (and ONLY the key path) rate-limits: OAuth resolution does no rate-limit
// bookkeeping, so a token that fails to resolve does not burn a key's budget.
//
// This module is also the clean seam #42 (audit provenance / `viaOAuth`) will
// extend: the branch taken is decided HERE and nowhere else.

import { auth } from '$lib/server/auth';
import { verifyBearerKey, type BearerVerification } from '$lib/server/api/verify';
import { scopeToPermissions } from '$lib/server/api/scope';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

/**
 * The OAuth scope token that grants write. The MCP OAuth server advertises
 * `read`/`write` as its scopes (#41 owns that config + the consent screen); here
 * we only CONSUME whatever `scopes` the returned token carries.
 */
const WRITE_SCOPE = 'write';

/**
 * Map an OAuth access token's `scopes` onto the plugin `permissions` shape the
 * §16.2 scope model reads.
 *
 * `session.scopes` is a SPACE-SEPARATED string (better-auth's `OAuthAccessToken`
 * shape). We split it and, if it carries the `write` scope token, encode a write
 * principal; otherwise a read principal — LEAST PRIVILEGE by default, matching
 * `scope.ts`'s philosophy, so a token with an empty / unknown / missing scope set
 * can never move money. Encoding through `scopeToPermissions` (rather than a bare
 * literal) keeps this in lock-step with `getApiKeyScope` / `filterToolsByScope` /
 * `requireWriteScope`, which then work UNCHANGED for an OAuth-derived principal.
 *
 * PURE and unit-testable with a bare string.
 */
export function oauthScopesToPermissions(
	scopes: string | null | undefined
): Record<string, string[]> {
	const tokens = (scopes ?? '').split(' ').filter(Boolean);
	return tokens.includes(WRITE_SCOPE) ? scopeToPermissions('write') : scopeToPermissions('read');
}

/**
 * Resolve an OAuth access token into an {@link ApiKeyPrincipal}, or `null` when
 * there is no usable OAuth session.
 *
 * `getMcpSession` reads the `Authorization: Bearer <token>` header itself and
 * returns `OAuthAccessToken | null` — `null` for a missing / expired / unknown
 * token (it also sets its own `WWW-Authenticate`, which we IGNORE; `/mcp` emits
 * its own via `mcpUnauthorized`). A session without a `userId` is treated as
 * unauthenticated. A thrown call (a DB blip) is swallowed to `null` so the
 * request simply falls through to the api-key path — the OAuth branch never turns
 * an infrastructure error into a hard failure of the whole endpoint.
 */
async function resolveOAuthPrincipal(request: Request): Promise<ApiKeyPrincipal | null> {
	let session: Awaited<ReturnType<typeof auth.api.getMcpSession>>;
	try {
		session = await auth.api.getMcpSession({ headers: request.headers });
	} catch (error) {
		console.error('[mcp/auth] getMcpSession threw', error);
		return null;
	}

	if (!session?.userId) return null;

	return {
		// `keyId` is the downstream PER-CALLER ISOLATION key: it is folded into the
		// idempotency dedup hash (`mcp/idempotency.ts`) and the tier-2 rate-limit
		// bucket (`api/rate-limit.ts`), so it MUST be unique per human caller. On the
		// OAuth path `clientId` identifies the registered APPLICATION (e.g. Claude.ai's
		// connector) — every distinct user connecting through that one app shares it —
		// so `clientId` ALONE would collide across tenants: two members of the same
		// group issuing an identical `create_transaction` within the idempotency window
		// would dedup into one write (a cross-tenant leak), and would share a rate-limit
		// budget. Composing `${clientId}:${userId}` restores per-user isolation while
		// keeping the client as a correlation prefix. (#42 uses the branch taken here to
		// record OAuth provenance.)
		keyId: `${session.clientId}:${session.userId}`,
		// No human key label on the OAuth path.
		name: null,
		userId: session.userId,
		permissions: oauthScopesToPermissions(session.scopes)
	};
}

/**
 * Resolve `/mcp` auth from EITHER credential, converging on one principal.
 *
 * OAuth FIRST (an api-key string never resolves as an OAuth token, so this is a
 * safe miss), then fall back to the EXISTING {@link verifyBearerKey} — unchanged,
 * including its `rate_limited` outcome. Only the key path rate-limits, so there is
 * no double-charging. Returns verify.ts's {@link BearerVerification} verbatim so
 * `handler.ts` handles both credential kinds identically.
 */
export async function resolveMcpAuth(request: Request): Promise<BearerVerification> {
	const oauthPrincipal = await resolveOAuthPrincipal(request);
	if (oauthPrincipal) return { ok: true, principal: oauthPrincipal };

	return verifyBearerKey(request.headers.get('authorization'));
}
