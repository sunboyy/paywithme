// Resuming a Claude.ai (OAuth connector) authorization after login.
//
// better-auth's MCP OAuth authorization endpoint sends an UNAUTHENTICATED caller
// to our `loginPage` (`/oauth/login`) with the pending OAuth request appended as
// query params (`response_type=code`, `client_id`, `redirect_uri`, `scope`,
// `code_challenge`, …). The plugin's own post-login resume only works when the
// sign-in is a full-page navigation (so its 302 back to the OAuth client's
// callback is followed by the browser). Our custom login signs in with a
// client-side `authClient` fetch (passkey), which SWALLOWS that redirect — so the
// flow never completes and Claude.ai reports "Authorization … failed".
//
// The fix: the dedicated `/oauth/login` route detects the continuation here and,
// after the user signs in, RESUMES it with a full-page navigation to the
// authorization endpoint (now that a session exists, it issues the code and 302s
// the browser to the client). This module is PURE and client-safe (no server
// imports) so both `+page.server.ts` and `+page.svelte` share one source of truth
// and it's trivially unit-testable.

/**
 * The better-auth MCP OAuth authorization endpoint. better-auth's `basePath` is
 * `/api/auth`; the `mcp` plugin serves authorize at `/mcp/authorize` (this is the
 * `authorization_endpoint` advertised in the discovery metadata).
 */
export const MCP_AUTHORIZE_PATH = '/api/auth/mcp/authorize';

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
 * If `search` (the `/login` URL's query) is an OAuth-authorization continuation,
 * return the SAME-ORIGIN path that resumes it — the authorization endpoint with
 * the original OAuth request forwarded verbatim. Otherwise return `null`.
 *
 * Safe to navigate to: it is always a local `/api/auth/mcp/authorize?…` path. The
 * embedded `redirect_uri` is only a query param — the authorization endpoint
 * validates it against the registered client, so this is not an open redirect.
 * Our own `redirectTo` param (invite flow) is dropped — it is not part of the
 * OAuth request.
 */
export function oauthResumeUrl(search: URLSearchParams): string | null {
	if (!isOAuthContinuation(search)) return null;
	const forwarded = new URLSearchParams(search);
	forwarded.delete('redirectTo');
	return `${MCP_AUTHORIZE_PATH}?${forwarded.toString()}`;
}
