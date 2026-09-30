// Unit test for GET /.well-known/oauth-authorization-server (RFC 8414 AS metadata,
// ADR-0010 §Decision(2), ADR-0018).
//
// We mock `$lib/server/auth` so the test is hermetic (no DB / env / Mailgun): the
// route wraps the REAL helper `oauthProviderAuthServerMetadata(auth)` from
// `@better-auth/oauth-provider`, whose only dependency on `auth` is a single
// `auth.api.getOAuthServerConfig(...)` call. Stubbing that method with realistic
// metadata exercises route → real helper → auth.api → 200 JSON Response, and
// asserts the document flows through unchanged, at the origin root.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Shaped like the provider's real output for this config (issuer = app origin,
// endpoints under /api/auth/oauth2).
const { asMetadata, getOAuthServerConfig } = vi.hoisted(() => {
	const asMetadata = {
		issuer: 'http://localhost:5173',
		authorization_endpoint: 'http://localhost:5173/api/auth/oauth2/authorize',
		token_endpoint: 'http://localhost:5173/api/auth/oauth2/token',
		registration_endpoint: 'http://localhost:5173/api/auth/oauth2/register',
		jwks_uri: 'http://localhost:5173/api/auth/jwks',
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
		code_challenge_methods_supported: ['S256']
	};
	return { asMetadata, getOAuthServerConfig: vi.fn(async () => asMetadata) };
});

vi.mock('$lib/server/auth', () => ({
	auth: { api: { getOAuthServerConfig } }
}));

// Imported after the mock is registered.
import { GET } from './+server';

/** Minimal RequestEvent — the handler reads only `request`. */
function makeEvent(request: Request) {
	return { request } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
	getOAuthServerConfig.mockClear();
});

describe('GET /.well-known/oauth-authorization-server', () => {
	it('returns 200 JSON AS metadata sourced from the auth instance', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-authorization-server');

		const res = await GET(makeEvent(request));

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toEqual(asMetadata);
	});

	it('delegates to auth.api.getOAuthServerConfig with the incoming request', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-authorization-server');

		await GET(makeEvent(request));

		expect(getOAuthServerConfig).toHaveBeenCalledTimes(1);
		expect(getOAuthServerConfig).toHaveBeenCalledWith(
			expect.objectContaining({ request, asResponse: false })
		);
	});
});
