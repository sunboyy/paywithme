// Verifying the connector's OAuth access token on `/mcp` (ADR-0010, ADR-0018).
//
// The authorization server (`@better-auth/mcp` in `auth.ts`) issues access tokens
// as JWTs signed by the `jwt` plugin, bound to the `/mcp` resource. They are NOT
// stored, so verifying one needs no token-table lookup: check the signature
// against the JWKS, then `iss`, `aud`, `exp` and the RFC 9068 `at+jwt` type.
//
// This is what the plugin's `requireMcpAuth` does, minus two things that don't fit
// here:
//   - it fetches the JWKS over HTTP from `${baseURL}/jwks`, i.e. from ourselves.
//     We read the same key set in-process through `auth.api.getJwks()`;
//   - it answers failures with its own 401. `/mcp` must fall back to the API-key
//     path and emit its own 401 (ADR-0009), so a failure here is just `null`.
//
// DPoP-bound tokens (RFC 9449) are supported the same way the library's
// `verifyAccessTokenRequest` does it: a token carrying `cnf.jkt` is accepted only
// with a valid `DPoP` proof for this exact request. Proof replay is blocked
// across instances by the database-backed replay store.

import {
	createDpopReplayStore,
	enforceDpopBinding,
	parseAccessTokenAuthorization,
	verifyJwsAccessToken
} from 'better-auth/oauth2';
import { auth, MCP_RESOURCE, OAUTH_ISSUER } from '$lib/server/auth';

/** The claims `/mcp` needs from a verified access token. */
export interface McpAccessToken {
	/** The resource owner (the `sub` claim). */
	userId: string;
	/** The OAuth client the token was issued to (the connected app). */
	clientId: string;
	/** Granted scopes, space-separated (the `scope` claim). */
	scopes: string;
}

/** RFC 9068 `typ` for JWT access tokens; ID tokens and other JWTs don't carry it. */
const ACCESS_TOKEN_TYPE = 'at+jwt';

// Stable key for the JWKS cache: the library caches the key set under this
// object, refetching on TTL expiry or an unknown `kid` (key rotation).
const JWKS_CACHE_KEY = {};

/** A compact JWS has three dot-separated parts. API keys (`pwm_…`) do not. */
function looksLikeJwt(token: string): boolean {
	return token.split('.').length === 3;
}

/**
 * Verify the request's OAuth access token for `/mcp`.
 *
 * Returns the token's claims, or `null` when there is no usable token: none sent,
 * an API key, a bad signature, the wrong issuer or audience, expired, or a
 * DPoP-bound token without a valid proof. Never throws. An infrastructure error
 * (e.g. the JWKS read fails) is logged and becomes `null` too, so the request
 * falls through to the API-key path instead of failing the endpoint.
 */
export async function verifyMcpAccessToken(request: Request): Promise<McpAccessToken | null> {
	const authorization = parseAccessTokenAuthorization(request.headers.get('authorization'));
	if (!authorization?.token || authorization.scheme === 'Unknown') return null;
	if (!looksLikeJwt(authorization.token)) return null;

	let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
	try {
		payload = await verifyJwsAccessToken(authorization.token, {
			jwksFetch: () => auth.api.getJwks(),
			jwksCacheKey: JWKS_CACHE_KEY,
			verifyOptions: { issuer: OAUTH_ISSUER, audience: MCP_RESOURCE, typ: ACCESS_TOKEN_TYPE }
		});
	} catch {
		// Invalid, expired, or for another audience: not an OAuth caller we accept.
		return null;
	}

	try {
		const { internalAdapter } = await auth.$context;
		await enforceDpopBinding({
			payload,
			authorization,
			proofJwt: request.headers.get('dpop'),
			method: request.method,
			url: request.url,
			replayStore: createDpopReplayStore(internalAdapter)
		});
	} catch {
		return null;
	}

	const userId = payload.sub;
	const clientId = payload.azp ?? payload.client_id;
	// A client-credentials token has `sub` = the client id and no user. `/mcp`
	// acts for a person, so it requires a user-bound token. The provider only
	// issues user tokens here (clients register for `authorization_code`), but a
	// token whose subject is its own client is refused regardless.
	if (typeof userId !== 'string' || !userId) return null;
	if (typeof clientId !== 'string' || !clientId || clientId === userId) return null;

	return {
		userId,
		clientId,
		scopes: typeof payload.scope === 'string' ? payload.scope : ''
	};
}
