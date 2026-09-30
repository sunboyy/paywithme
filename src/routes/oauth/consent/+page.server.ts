// `/oauth/consent` — the MCP OAuth connector consent screen (ADR-0010 §Decision(4),
// #41, ADR-0018).
//
// When Claude.ai (or any registered MCP client) asks this app for a user-scoped
// access token, the OAuth provider logs the user in (`loginPage: '/oauth/login'`)
// and then, when consent is required, REDIRECTS the already-logged-in
// resource-owner here with the pending authorization request as SIGNED query
// params: `client_id`, `redirect_uri`, the requested `scope` (space-separated),
// …, plus `sig` / `exp`. The signature is what makes the request trustworthy: the
// whole query string travels back to the provider as `oauth_query`, which it
// verifies before acting.
//
// This screen reproduces the SAME conscious read-vs-write ("can this connection
// move money?") choice the api-key minting UI makes (ADR-0007), so the two
// credential surfaces feel like one product. On Allow / Deny we POST the decision
// to the provider's consent endpoint and redirect the user back to the client.
//
// SERVER-FIRST: the decision travels through the route's `allow` / `deny` form
// actions, so it works with JS disabled. It is driven server-side via
// `auth.api.oauth2Consent(...)` (forwarding the session cookie in `headers`,
// exactly as `/login` forwards headers to `signInMagicLink`) rather than a browser
// fetch — the endpoint (`/api/auth/oauth2/consent`) is session-gated.

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

/** The requesting client's self-registered name, or `null` if it has none. */
async function clientName(clientId: string, headers: Headers): Promise<string | null> {
	try {
		const client = await auth.api.getOAuthClientPublic({ query: { client_id: clientId }, headers });
		return client?.client_name ?? null;
	} catch {
		// Unknown / disabled client: the provider will refuse the request anyway.
		return null;
	}
}

/** The host the user is sent back to, e.g. `claude.ai`. */
function redirectHost(raw: string | null): string | null {
	if (!raw) return null;
	try {
		return new URL(raw).host;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ locals, url, request }) => {
	// The AS only reaches this page AFTER establishing a session, but guard anyway:
	// a consent decision acts on the caller's own account, so a session is required.
	// Preserve the consent params through the login round-trip so the flow resumes.
	if (!locals.user) {
		redirect(303, '/login?redirectTo=' + encodeURIComponent(url.pathname + url.search));
	}

	const clientId = url.searchParams.get('client_id');
	const scopes = parseScopes(url.searchParams.get('scope'));
	// Only a request the provider signed is one we can act on. The signature itself
	// is verified by the provider when the decision is posted.
	const oauthQuery = url.searchParams.has('sig') && clientId ? url.search.slice(1) : null;

	// `write` present ⇒ this connection can MOVE MONEY. This is the single most
	// consequential fact on the page, mirroring the api-key scope picker (§16.2).
	const canMoveMoney = scopes.includes(OAUTH_WRITE_SCOPE);

	return {
		oauthQuery,
		clientId,
		// Self-reported at registration, so the page also shows `returnsTo`, the
		// callback host the provider checked against the registration.
		clientName: oauthQuery && clientId ? await clientName(clientId, request.headers) : null,
		returnsTo: redirectHost(url.searchParams.get('redirect_uri')),
		scopes,
		canMoveMoney
	};
};

/**
 * Post the consent decision to the provider's session-gated `/oauth2/consent`
 * endpoint via the server API (forwarding the session cookie), then redirect the
 * user to the URL it returns — the client's `redirect_uri` carrying the
 * authorization `code` on Allow, or `?error=access_denied` on Deny.
 */
async function decide(request: Request, accept: boolean) {
	const formData = await request.formData();
	const oauthQuery = formData.get('oauth_query');
	if (typeof oauthQuery !== 'string' || oauthQuery.length === 0) {
		return fail(400, { error: 'This consent request is missing or has expired. Start again.' });
	}

	let result: { url?: string } | null;
	try {
		result = await auth.api.oauth2Consent({
			body: { accept, oauth_query: oauthQuery },
			headers: request.headers,
			// On Allow the provider re-runs its authorize step, which needs a Request
			// in context (a bare server-side call has none). Passing one would make
			// the call return a Response, so ask for the parsed body.
			request,
			asResponse: false
		});
	} catch (err) {
		// A bad / expired signature lands here too. Never surface the provider's raw
		// cause (PLAN §12) — a generic message only; log it server-side.
		console.error('[oauth/consent] consent decision failed', err);
		return fail(400, {
			error: 'This consent request is no longer valid. Return to the app and try again.'
		});
	}

	if (!result?.url) {
		return fail(500, { error: 'Could not complete the request. Please try again.' });
	}

	// Hand control back to the OAuth client (an EXTERNAL URL). `redirect()` throws.
	redirect(303, result.url);
}
export const actions: Actions = {
	// Grant the requested scopes.
	allow: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		return decide(request, true);
	},
	// Refuse — the provider returns a redirect back to the client with access_denied.
	deny: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		return decide(request, false);
	}
};
