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
// The fix: the dedicated `/oauth/login` route detects the continuation here and,
// after the user signs in, RESUMES it with a full-page navigation to the
// authorization endpoint (now that a session exists, it issues the code and 302s
// the browser to the client). This module is PURE and client-safe (no server
// imports) so both `+page.server.ts` and `+page.svelte` share one source of truth
// and it's trivially unit-testable.

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

/**
 * The params that identify a login as an OAuth-authorization continuation. All
 * three must be present (and `response_type` must be `code`) — a bare `/login`
 * visit or the invite flow (`?redirectTo=…`) has none of them.
 */
function isOAuthContinuation(search: URLSearchParams): boolean {
	return (
		search.get('response_type') === 'code' &&
		!!search.get('client_id') &&
		!!search.get('redirect_uri')
	);
}

/**
 * Did the client ask for a FRESH login (`prompt=login`, or `max_age`)? Then an
 * existing session is not enough: the user must sign in again on this page
 * before the authorization resumes.
 */
export function requiresFreshLogin(search: URLSearchParams): boolean {
	const prompts = (search.get('prompt') ?? '').split(' ');
	return prompts.includes('login') || search.has('max_age');
}

/**
 * If `search` (the login page's query) is an OAuth-authorization continuation,
 * return the SAME-ORIGIN path that resumes it — the authorization endpoint with
 * the original OAuth request forwarded. Otherwise return `null`.
 *
 * Forwarded verbatim except for:
 *   - the provider's signing params ({@link SIGNING_PARAMS});
 *   - our own `redirectTo` param (invite flow);
 *   - `prompt=login` and `max_age`. The resume URL is only followed once the user
 *     has signed in on this page, which satisfies both. Forwarding them would
 *     send the user straight back here, in a loop. (The provider strips them the
 *     same way when it resumes a flow itself.)
 *
 * Safe to navigate to: it is always a local `/api/auth/oauth2/authorize?…` path.
 * The embedded `redirect_uri` is only a query param — the authorization endpoint
 * validates it against the registered client, so this is not an open redirect.
 */
export function oauthResumeUrl(search: URLSearchParams): string | null {
	if (!isOAuthContinuation(search)) return null;
	const forwarded = new URLSearchParams(search);
	forwarded.delete('redirectTo');
	for (const param of SIGNING_PARAMS) forwarded.delete(param);
	forwarded.delete('max_age');
	const prompt = (forwarded.get('prompt') ?? '')
		.split(' ')
		.filter((value) => value && value !== 'login')
		.join(' ');
	if (prompt) forwarded.set('prompt', prompt);
	else forwarded.delete('prompt');
	return `${MCP_AUTHORIZE_PATH}?${forwarded.toString()}`;
}
