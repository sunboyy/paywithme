import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Route tests for `/oauth/consent` (ADR-0010 §Decision(4), #41).
//
// The contract this file defends:
//   - LOAD parses the AS-supplied `consent_code` / `client_id` / `scope` query
//     params and surfaces the read-vs-write ("can it move money?") decision.
//   - The ALLOW / DENY actions post the RIGHT body (`{ accept, consent_code }`) to
//     the session-gated consent endpoint (driven server-side via
//     `auth.api.oAuthConsent`, forwarding the request headers), and redirect the
//     user to the URI the endpoint returns (the client's `redirect_uri`).
//   - A generic error only — the plugin's raw cause is never surfaced (PLAN §12).
//   - DRIFT GUARD: this route lives at exactly `/oauth/consent`, the literal the
//     mcp plugin's `oidcConfig.consentPage` is wired to in `lib/server/auth.ts`.

const { oAuthConsent } = vi.hoisted(() => ({ oAuthConsent: vi.fn() }));

vi.mock('$lib/server/auth', () => ({ auth: { api: { oAuthConsent } } }));

import { load, actions } from './+page.server';

const USER = { id: 'user_1', name: 'Ann' };

/** The shape `load` returns (its `PageServerLoad` type widens to include `void`). */
interface ConsentData {
	consentCode: string | null;
	clientId: string | null;
	scopes: string[];
	canMoveMoney: boolean;
}

function makeLoadEvent(query: string, user: typeof USER | null = USER) {
	const url = new URL('http://localhost/oauth/consent' + query);
	return { locals: { user }, url } as unknown as Parameters<typeof load>[0];
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
	oAuthConsent.mockReset();
});

describe('/oauth/consent load', () => {
	it('redirects an anonymous visitor to /login, preserving the consent params', async () => {
		try {
			await load(makeLoadEvent('?consent_code=c1&client_id=app&scope=read', null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				// The consent params survive the login round-trip so the flow resumes.
				expect(e.location).toContain('/login?redirectTo=');
				expect(decodeURIComponent(e.location)).toContain('/oauth/consent?consent_code=c1');
			}
		}
	});

	it('parses consent_code / client_id / scope and flags a WRITE request as money-moving', async () => {
		const data = await runLoad(
			makeLoadEvent('?consent_code=c1&client_id=claude&scope=openid+read+write')
		);

		expect(data).toEqual({
			consentCode: 'c1',
			clientId: 'claude',
			scopes: ['openid', 'read', 'write'],
			canMoveMoney: true
		});
	});

	it('flags a READ-only request as NOT money-moving (least privilege)', async () => {
		const data = await runLoad(
			makeLoadEvent('?consent_code=c1&client_id=claude&scope=openid+read')
		);

		expect(data.canMoveMoney).toBe(false);
		expect(data.scopes).toEqual(['openid', 'read']);
	});

	it('surfaces a null consent code when reached without an active request', async () => {
		const data = await runLoad(makeLoadEvent(''));

		expect(data.consentCode).toBeNull();
		expect(data.scopes).toEqual([]);
		expect(data.canMoveMoney).toBe(false);
	});
});

describe('/oauth/consent allow / deny actions', () => {
	it('ALLOW posts { accept: true, consent_code } and redirects to the returned client URI', async () => {
		oAuthConsent.mockResolvedValue({ redirectURI: 'https://claude.ai/callback?code=xyz' });
		const event = makeActionEvent({ consent_code: 'c1' });

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

		expect(oAuthConsent).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { accept: true, consent_code: 'c1' },
				asResponse: false,
				headers: expect.any(Headers)
			})
		);
	});

	it('DENY posts { accept: false, consent_code } and redirects to the access_denied URI', async () => {
		oAuthConsent.mockResolvedValue({
			redirectURI: 'https://claude.ai/callback?error=access_denied'
		});
		const event = makeActionEvent({ consent_code: 'c1' });

		try {
			await actions.deny(event);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('https://claude.ai/callback?error=access_denied');
		}

		expect(oAuthConsent).toHaveBeenCalledWith(
			expect.objectContaining({ body: { accept: false, consent_code: 'c1' } })
		);
	});

	it('fails (and calls nothing) when the consent_code is missing', async () => {
		const event = makeActionEvent({});

		const result = (await actions.allow(event)) as { status: number };

		expect(result.status).toBe(400);
		expect(oAuthConsent).not.toHaveBeenCalled();
	});

	it('surfaces a GENERIC error (never the raw cause) when the endpoint throws', async () => {
		oAuthConsent.mockRejectedValue(new Error('plugin said: consent_code leaked in message'));
		const event = makeActionEvent({ consent_code: 'c1' });

		const result = (await actions.allow(event)) as { status: number; data: { error: string } };

		expect(result.status).toBe(400);
		expect(result.data.error).not.toContain('plugin said');
		expect(result.data.error).not.toContain('leaked');
	});

	it('redirects an anonymous POST to /login and posts no decision', async () => {
		const event = makeActionEvent({ consent_code: 'c1' }, null);

		try {
			await actions.allow(event);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('/login');
		}
		expect(oAuthConsent).not.toHaveBeenCalled();
	});
});

describe('/oauth/consent route location', () => {
	// The mcp plugin's `oidcConfig.consentPage` (in `lib/server/auth.ts`) is wired to
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
