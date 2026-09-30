import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Route tests for `/oauth/consent` (ADR-0010 §Decision(4), #41, ADR-0018).
//
// The contract this file defends:
//   - LOAD reads the provider-SIGNED request (`client_id`, `scope`, …, `sig`),
//     surfaces the read-vs-write ("can it move money?") decision, and hands the
//     whole query back to the page as `oauthQuery` — only when it is signed.
//   - The ALLOW / DENY actions post `{ accept, oauth_query }` to the session-gated
//     consent endpoint (driven server-side via `auth.api.oauth2Consent`,
//     forwarding the request), and redirect the user to the URL it returns (the
//     client's `redirect_uri`).
//   - A generic error only — the provider's raw cause is never surfaced (PLAN §12).
//   - DRIFT GUARD: this route lives at exactly `/oauth/consent`, the literal the
//     provider's `consentPage` is wired to in `lib/server/auth.ts`.

const { oauth2Consent, getOAuthClientPublic } = vi.hoisted(() => ({
	oauth2Consent: vi.fn(),
	getOAuthClientPublic: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({ auth: { api: { oauth2Consent, getOAuthClientPublic } } }));

import { load, actions } from './+page.server';

const USER = { id: 'user_1', name: 'Ann' };

/** The shape `load` returns (its `PageServerLoad` type widens to include `void`). */
interface ConsentData {
	oauthQuery: string | null;
	clientId: string | null;
	clientName: string | null;
	returnsTo: string | null;
	scopes: string[];
	canMoveMoney: boolean;
}

/** A signed request as the provider appends it (signature params abbreviated). */
const SIGNED =
	'?response_type=code&client_id=claude&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
	'&scope=openid+read+write&state=s&exp=1&ba_iat=1&sig=abc';

function makeLoadEvent(query: string, user: typeof USER | null = USER) {
	const url = new URL('http://localhost/oauth/consent' + query);
	const request = new Request(url, { headers: { cookie: 'session=abc' } });
	return { locals: { user }, url, request } as unknown as Parameters<typeof load>[0];
}

/** Run `load` on its success path, narrowing away the redirect/void possibility. */
async function runLoad(event: Parameters<typeof load>[0]): Promise<ConsentData> {
	return (await load(event)) as unknown as ConsentData;
}

/** A form-encoded POST — exactly the shape a no-JS Allow/Deny submission arrives in. */
function makeActionEvent(fields: Record<string, string>, user: typeof USER | null = USER) {
	const request = new Request('http://localhost/oauth/consent', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=abc' },
		body: new URLSearchParams(fields).toString()
	});
	return { request, locals: { user } } as unknown as Parameters<(typeof actions)['allow']>[0];
}

beforeEach(() => {
	oauth2Consent.mockReset();
	getOAuthClientPublic.mockReset();
	getOAuthClientPublic.mockResolvedValue({ client_id: 'claude', client_name: 'Claude' });
});

describe('/oauth/consent load', () => {
	it('redirects an anonymous visitor to /login, preserving the signed request', async () => {
		try {
			await load(makeLoadEvent(SIGNED, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				// The signed params survive the login round-trip so the flow resumes.
				expect(e.location).toContain('/login?redirectTo=');
				expect(decodeURIComponent(e.location)).toContain('/oauth/consent?response_type=code');
				expect(decodeURIComponent(e.location)).toContain('sig=abc');
			}
		}
	});

	it('reads the signed request and flags a WRITE request as money-moving', async () => {
		const data = await runLoad(makeLoadEvent(SIGNED));

		expect(data).toEqual({
			// The whole query, verbatim, for the provider to verify on submit.
			oauthQuery: SIGNED.slice(1),
			clientId: 'claude',
			clientName: 'Claude',
			returnsTo: 'claude.ai',
			scopes: ['openid', 'read', 'write'],
			canMoveMoney: true
		});
		expect(getOAuthClientPublic).toHaveBeenCalledWith(
			expect.objectContaining({ query: { client_id: 'claude' } })
		);
	});

	it('flags a READ-only request as NOT money-moving (least privilege)', async () => {
		const data = await runLoad(makeLoadEvent(SIGNED.replace('openid+read+write', 'openid+read')));

		expect(data.canMoveMoney).toBe(false);
		expect(data.scopes).toEqual(['openid', 'read']);
	});

	it('shows no client name when the provider does not know the client', async () => {
		getOAuthClientPublic.mockRejectedValue(new Error('not_found'));

		const data = await runLoad(makeLoadEvent(SIGNED));

		expect(data.clientName).toBeNull();
		// The page is still rendered; the provider refuses the decision itself.
		expect(data.oauthQuery).not.toBeNull();
	});

	it('has no active request when the query is unsigned (e.g. a hand-typed URL)', async () => {
		const data = await runLoad(makeLoadEvent('?client_id=claude&scope=read'));

		expect(data.oauthQuery).toBeNull();
		expect(getOAuthClientPublic).not.toHaveBeenCalled();
	});

	it('has no active request when reached with no query at all', async () => {
		const data = await runLoad(makeLoadEvent(''));

		expect(data.oauthQuery).toBeNull();
		expect(data.scopes).toEqual([]);
		expect(data.canMoveMoney).toBe(false);
	});
});

describe('/oauth/consent allow / deny actions', () => {
	it('ALLOW posts { accept: true, oauth_query } and redirects to the returned client URL', async () => {
		oauth2Consent.mockResolvedValue({ redirect: true, url: 'https://claude.ai/callback?code=xyz' });
		const event = makeActionEvent({ oauth_query: 'client_id=claude&sig=abc' });

		try {
			await actions.allow(event);
			expect.unreachable('expected a redirect to the client');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('https://claude.ai/callback?code=xyz');
			}
		}

		expect(oauth2Consent).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { accept: true, oauth_query: 'client_id=claude&sig=abc' },
				headers: expect.any(Headers),
				// The provider's authorize step needs the Request in context.
				request: expect.any(Request),
				asResponse: false
			})
		);
	});

	it('DENY posts { accept: false, oauth_query } and redirects to the access_denied URL', async () => {
		oauth2Consent.mockResolvedValue({
			redirect: true,
			url: 'https://claude.ai/callback?error=access_denied'
		});
		const event = makeActionEvent({ oauth_query: 'client_id=claude&sig=abc' });

		try {
			await actions.deny(event);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('https://claude.ai/callback?error=access_denied');
		}

		expect(oauth2Consent).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { accept: false, oauth_query: 'client_id=claude&sig=abc' }
			})
		);
	});

	it('fails (and calls nothing) when the oauth_query is missing', async () => {
		const event = makeActionEvent({});

		const result = (await actions.allow(event)) as { status: number };

		expect(result.status).toBe(400);
		expect(oauth2Consent).not.toHaveBeenCalled();
	});

	it('surfaces a GENERIC error (never the raw cause) when the endpoint throws', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		oauth2Consent.mockRejectedValue(new Error('plugin said: invalid_signature leaked in message'));
		const event = makeActionEvent({ oauth_query: 'client_id=claude&sig=forged' });

		const result = (await actions.allow(event)) as { status: number; data: { error: string } };

		expect(result.status).toBe(400);
		expect(result.data.error).not.toContain('plugin said');
		expect(result.data.error).not.toContain('leaked');
		spy.mockRestore();
	});

	it('fails with a generic 500 when the endpoint returns no redirect URL', async () => {
		oauth2Consent.mockResolvedValue({});
		const event = makeActionEvent({ oauth_query: 'client_id=claude&sig=abc' });

		const result = (await actions.allow(event)) as { status: number };

		expect(result.status).toBe(500);
	});

	it('redirects an anonymous POST to /login and posts no decision', async () => {
		const event = makeActionEvent({ oauth_query: 'client_id=claude&sig=abc' }, null);

		try {
			await actions.allow(event);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('/login');
		}
		expect(oauth2Consent).not.toHaveBeenCalled();
	});
});

describe('/oauth/consent route location', () => {
	// The provider's `consentPage` (in `lib/server/auth.ts`) is wired to
	// `/oauth/consent`; the AS redirects the user HERE. If this route moved, the
	// connector flow would 404 at consent. This guard fails loudly on drift.
	it('is served at exactly /oauth/consent (the wired consentPage)', () => {
		const routeDir = dirname(fileURLToPath(import.meta.url));
		// `src/routes` — two levels up from `oauth/consent`.
		const routesRoot = resolve(routeDir, '../..');
		const servedPath = '/' + relative(routesRoot, routeDir);

		expect(servedPath).toBe('/oauth/consent');
		expect(existsSync(resolve(routeDir, '+page.svelte'))).toBe(true);
	});
});
