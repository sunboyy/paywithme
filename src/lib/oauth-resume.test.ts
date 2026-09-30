import { describe, expect, it } from 'vitest';
import { oauthResumeUrl, requiresFreshLogin, MCP_AUTHORIZE_PATH } from './oauth-resume';

/** The params the OAuth authorize endpoint appends when it bounces to /oauth/login. */
function authorizeParams(overrides: Record<string, string> = {}): URLSearchParams {
	return new URLSearchParams({
		response_type: 'code',
		client_id: 'client_abc',
		redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
		scope: 'openid read',
		code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
		code_challenge_method: 'S256',
		state: 'xyz',
		...overrides
	});
}

describe('oauthResumeUrl', () => {
	it('rebuilds the authorization endpoint URL for a genuine OAuth continuation', () => {
		const url = oauthResumeUrl(authorizeParams());
		expect(url).not.toBeNull();
		expect(url!.startsWith(`${MCP_AUTHORIZE_PATH}?`)).toBe(true);

		// Every OAuth request param is forwarded verbatim so the resumed authorize
		// issues a code for the SAME client + PKCE challenge Claude.ai started with.
		const forwarded = new URLSearchParams(url!.slice(url!.indexOf('?') + 1));
		expect(forwarded.get('response_type')).toBe('code');
		expect(forwarded.get('client_id')).toBe('client_abc');
		expect(forwarded.get('redirect_uri')).toBe('https://claude.ai/api/mcp/auth_callback');
		expect(forwarded.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
		expect(forwarded.get('code_challenge_method')).toBe('S256');
		expect(forwarded.get('state')).toBe('xyz');
		expect(forwarded.get('scope')).toBe('openid read');
	});

	it('is a same-origin path (never an open redirect, despite the off-origin redirect_uri param)', () => {
		const url = oauthResumeUrl(authorizeParams());
		expect(url!.startsWith('/')).toBe(true);
		expect(url!.startsWith('//')).toBe(false);
		// The claude.ai URL is only a query param, not the navigation target.
		expect(url!.startsWith(MCP_AUTHORIZE_PATH)).toBe(true);
	});

	it('targets the oauth-provider authorize endpoint', () => {
		expect(MCP_AUTHORIZE_PATH).toBe('/api/auth/oauth2/authorize');
	});

	it('drops the provider signing params (sig, exp, ba_*), which are not part of the request', () => {
		const signed = authorizeParams({ exp: '1790784420', ba_iat: '1790783820375', sig: 'abc=' });
		signed.append('ba_param', 'client_id');
		signed.append('ba_param', 'scope');
		signed.set('ba_pl', 'session_1');

		const forwarded = new URLSearchParams(oauthResumeUrl(signed)!.split('?')[1]);

		for (const param of ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl']) {
			expect(forwarded.has(param)).toBe(false);
		}
		expect(forwarded.get('client_id')).toBe('client_abc');
	});

	it('drops prompt=login and max_age so the resumed authorize does not loop back to login', () => {
		const forwarded = new URLSearchParams(
			oauthResumeUrl(authorizeParams({ prompt: 'login consent', max_age: '0' }))!.split('?')[1]
		);

		// Other prompt values survive.
		expect(forwarded.get('prompt')).toBe('consent');
		expect(forwarded.has('max_age')).toBe(false);

		const onlyLogin = new URLSearchParams(
			oauthResumeUrl(authorizeParams({ prompt: 'login' }))!.split('?')[1]
		);
		expect(onlyLogin.has('prompt')).toBe(false);
	});

	it('drops our own redirectTo param (it is not part of the OAuth request)', () => {
		const url = oauthResumeUrl(authorizeParams({ redirectTo: '/invite/tok' }));
		const forwarded = new URLSearchParams(url!.slice(url!.indexOf('?') + 1));
		expect(forwarded.has('redirectTo')).toBe(false);
	});

	it('returns null for a plain login visit (no OAuth params)', () => {
		expect(oauthResumeUrl(new URLSearchParams())).toBeNull();
	});

	it('returns null for the invite flow (redirectTo only, no OAuth request)', () => {
		expect(oauthResumeUrl(new URLSearchParams({ redirectTo: '/invite/tok' }))).toBeNull();
	});

	it('returns null when any required OAuth param is missing', () => {
		// response_type not "code"
		expect(oauthResumeUrl(authorizeParams({ response_type: 'token' }))).toBeNull();
		// missing client_id
		const noClient = authorizeParams();
		noClient.delete('client_id');
		expect(oauthResumeUrl(noClient)).toBeNull();
		// missing redirect_uri
		const noRedirect = authorizeParams();
		noRedirect.delete('redirect_uri');
		expect(oauthResumeUrl(noRedirect)).toBeNull();
	});
});

describe('requiresFreshLogin', () => {
	it('is true for prompt=login (alone or with other prompts) and for max_age', () => {
		expect(requiresFreshLogin(authorizeParams({ prompt: 'login' }))).toBe(true);
		expect(requiresFreshLogin(authorizeParams({ prompt: 'consent login' }))).toBe(true);
		expect(requiresFreshLogin(authorizeParams({ max_age: '3600' }))).toBe(true);
	});

	it('is false otherwise', () => {
		expect(requiresFreshLogin(authorizeParams())).toBe(false);
		expect(requiresFreshLogin(authorizeParams({ prompt: 'consent' }))).toBe(false);
	});
});
