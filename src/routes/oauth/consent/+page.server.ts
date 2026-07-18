// `/oauth/consent` — the MCP OAuth connector consent screen (ADR-0010 §Decision(4),
// #41).
//
// When Claude.ai (or any registered MCP client) asks this app for a user-scoped
// access token, better-auth's mcp/oidc-provider plugin logs the user in
// (`loginPage: '/oauth/login'`) and then, when consent is required, REDIRECTS the
// already-logged-in resource-owner here with `consent_code`, `client_id`, and the
// requested `scope` (space-separated) as query params (see the plugin's
// `authorize()` — `oidcConfig.consentPage` branch).
//
// This screen reproduces the SAME conscious read-vs-write ("can this connection
// move money?") choice the api-key minting UI makes (ADR-0007), so the two
// credential surfaces feel like one product. On Allow / Deny we POST the decision
// to the plugin's consent endpoint and redirect the user back to the client.
//
// SERVER-FIRST: the decision travels through the route's `allow` / `deny` form
// actions, so it works with JS disabled. The decision is driven server-side via
// `auth.api.oAuthConsent(...)` (forwarding the session cookie in `headers`, exactly
// as `/login` forwards headers to `signInMagicLink`) rather than a browser fetch —
// the plugin's `/oauth2/consent` endpoint is session-gated (`sessionMiddleware`).
// The HTTP path that endpoint lives at is `/api/auth/oauth2/consent` (auth basePath
// `/api/auth` + the oidc-provider endpoint `/oauth2/consent`); there is NO
// `/mcp/consent` alias, so calling it by its server API is both correct and avoids
// hard-coding the path.

import { fail, redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { OAUTH_WRITE_SCOPE } from '$lib/server/api/scope';
import type { Actions, PageServerLoad } from './$types';

/** Parse the space-separated `scope` query param into distinct, non-empty tokens. */
function parseScopes(raw: string | null): string[] {
	return (raw ?? '')
		.split(' ')
		.map((s) => s.trim())
		.filter(Boolean);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// The AS only reaches this page AFTER establishing a session, but guard anyway:
	// a consent decision acts on the caller's own account, so a session is required.
	// Preserve the consent params through the login round-trip so the flow resumes.
	if (!locals.user) {
		redirect(303, '/login?redirectTo=' + encodeURIComponent(url.pathname + url.search));
	}

	const consentCode = url.searchParams.get('consent_code');
	const clientId = url.searchParams.get('client_id');
	const scopes = parseScopes(url.searchParams.get('scope'));

	// `write` present ⇒ this connection can MOVE MONEY. This is the single most
	// consequential fact on the page, mirroring the api-key scope picker (§16.2).
	const canMoveMoney = scopes.includes(OAUTH_WRITE_SCOPE);

	return { consentCode, clientId, scopes, canMoveMoney };
};

/**
 * Post the consent decision to the plugin's session-gated `/oauth2/consent`
 * endpoint via the server API (forwarding the session cookie), then redirect the
 * user to the URI the endpoint returns — the client's `redirect_uri` carrying the
 * authorization `code` on Allow, or `?error=access_denied` on Deny.
 */
async function decide(request: Request, accept: boolean) {
	const formData = await request.formData();
	const consentCode = formData.get('consent_code');
	if (typeof consentCode !== 'string' || consentCode.length === 0) {
		return fail(400, { error: 'This consent request is missing or has expired. Start again.' });
	}

	let result: { redirectURI?: string } | null;
	try {
		result = await auth.api.oAuthConsent({
			body: { accept, consent_code: consentCode },
			headers: request.headers,
			asResponse: false
		});
	} catch {
		// Never surface the plugin's raw cause (PLAN §12) — a generic message only.
		return fail(400, {
			error: 'This consent request is no longer valid. Return to the app and try again.'
		});
	}

	if (!result?.redirectURI) {
		return fail(500, { error: 'Could not complete the request. Please try again.' });
	}

	// Hand control back to the OAuth client (an EXTERNAL URL). `redirect()` throws.
	redirect(303, result.redirectURI);
}

export const actions: Actions = {
	// Grant the requested scopes.
	allow: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		return decide(request, true);
	},
	// Refuse — the plugin returns a redirect back to the client with access_denied.
	deny: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		return decide(request, false);
	}
};
