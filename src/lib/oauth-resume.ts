// Resuming a Claude.ai (OAuth connector) authorization after login.
//
// The OAuth authorization endpoint sends an UNAUTHENTICATED caller to our
// `loginPage` (`/oauth/login`) with the pending OAuth request appended as SIGNED
// query params (`response_type=code`, `client_id`, `redirect_uri`, `scope`,
// `code_challenge`, …, `sig`). The provider can resume the flow itself only when
// the sign-in request carries that query as `oauth_query`, and then it answers
// with the client's callback URL. That doesn't fit either of our sign-ins: the
// passkey sign-in is a client-side `authClient` fetch, and the magic link is
// verified later, possibly on another device.
//
// The fix: the dedicated `/oauth/login` route resumes the flow itself. After a
// sign-in, the browser reloads that page and its `load` redirects to the
// authorization endpoint, which issues the code and 302s to the client. The
// decision to resume is made ONLY there, on the server, against the session's
// real creation time — so `prompt=login` / `max_age` are honoured and an old
// session can't stand in for a fresh sign-in. This module is PURE (no server
// imports), so it is trivially unit-testable.

/**
 * The OAuth authorization endpoint (`@better-auth/oauth-provider`, which the
 * `mcp` plugin is built on). better-auth's `basePath` is `/api/auth`; this is the
 * `authorization_endpoint` advertised in the discovery metadata.
 */
export const MCP_AUTHORIZE_PATH = '/api/auth/oauth2/authorize';

/**
 * Params the provider ADDS when it redirects to the login page: the signature
 * over the request (`sig`), its expiry, and bookkeeping (`ba_*`). They are not
 * part of the authorization request, so they are dropped before resuming.
 */
const SIGNING_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'];

/** The provider's signed issue time (ms) of the request it redirected with. */
const ISSUED_AT_PARAM = 'ba_iat';

/**
 * The params that identify a login as an OAuth-authorization continuation. All
 * three must be present (and `response_type` must be `code`) — a bare `/login`
 * visit or the invite flow (`?redirectTo=…`) has none of them.
 */
export function isOAuthContinuation(search: URLSearchParams): boolean {
	return (
		search.get('response_type') === 'code' &&
		!!search.get('client_id') &&
		!!search.get('redirect_uri')
	);
}

/**
 * Was the session created AFTER the provider sent the user to the login page?
 * That is a sign-in made for this request, which is what `prompt=login` asks for.
 * Same rule as the provider's own resume (`isSessionFreshForSignedQuery`). A
 * request without the issue time (never one the provider built) is not fresh.
 */
function isFreshForRequest(search: URLSearchParams, sessionCreatedAt: Date): boolean {
	const issuedAt = Number(search.get(ISSUED_AT_PARAM));
	if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
	return sessionCreatedAt.getTime() >= issuedAt;
}

/**
 * The same-origin path that resumes the authorization for a signed-in user, or
 * `null` when their session doesn't satisfy the request and they must sign in
 * again on this page first.
 *
 * The client can ask for a recent login:
 *   - `prompt=login`: only a session created for THIS request will do;
 *   - `max_age=N`: the session must be at most N seconds old.
 * A fresh session satisfies both, and both are then dropped, as the provider does
 * when it resumes a flow itself (`max_age=0` could otherwise never pass). An
 * older session can still satisfy `max_age`; the param is then kept, and the
 * authorize endpoint checks it again with the same rule.
 *
 * Otherwise forwarded verbatim, minus the provider's signing params
 * ({@link SIGNING_PARAMS}) and our own `redirectTo` (invite flow). Always a local
 * `/api/auth/oauth2/authorize?…` path: the embedded `redirect_uri` is only a
 * query param, validated against the registered client, so not an open redirect.
 */
export function oauthResumeUrl(
	search: URLSearchParams,
	sessionCreatedAt: Date,
	now: Date = new Date()
): string | null {
	if (!isOAuthContinuation(search)) return null;
	const fresh = isFreshForRequest(search, sessionCreatedAt);
	const prompts = (search.get('prompt') ?? '').split(' ').filter(Boolean);
	if (prompts.includes('login') && !fresh) return null;
	const forwarded = new URLSearchParams(search);
	if (forwarded.has('max_age')) {
		const maxAge = Number(forwarded.get('max_age'));
		const age = now.getTime() - sessionCreatedAt.getTime();
		if (fresh) forwarded.delete('max_age');
		else if (!(maxAge > 0) || age > maxAge * 1000) return null;
	}
	forwarded.delete('redirectTo');
	for (const param of SIGNING_PARAMS) forwarded.delete(param);
	const prompt = prompts.filter((value) => value !== 'login').join(' ');
	if (prompt) forwarded.set('prompt', prompt);
	else forwarded.delete('prompt');
	return `${MCP_AUTHORIZE_PATH}?${forwarded.toString()}`;
}
