import { describe, expect, it } from 'vitest';
import { oauthResumeUrl, MCP_AUTHORIZE_PATH } from './oauth-resume';

/** The params better-auth's authorize endpoint appends when it bounces to /login. */
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
