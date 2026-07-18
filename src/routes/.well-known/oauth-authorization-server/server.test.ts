// Unit test for GET /.well-known/oauth-authorization-server (RFC 8414 AS metadata,
// ADR-0010 §Decision(2)).
//
// We mock `$lib/server/auth` so the test is hermetic (no DB / env / Mailgun): the
// route wraps the REAL better-auth helper `oAuthDiscoveryMetadata(auth)`, whose
// only dependency on `auth` is a single `auth.api.getMcpOAuthConfig(...)` call. By
// stubbing that method with realistic RFC 8414 metadata we exercise the real code
// path — route → real helper → auth.api → 200 JSON Response — and assert the
// discovery document (issuer + authorization/token/registration endpoints) flows
// through unchanged, at the origin root, without touching a database.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// The metadata the AS discovery endpoint sources from the `auth` instance. Shaped
// like better-auth's real `getMCPProviderMetadata` output (RFC 8414).
const { asMetadata, getMcpOAuthConfig } = vi.hoisted(() => {
	const asMetadata = {
		issuer: 'http://localhost:5173',
		authorization_endpoint: 'http://localhost:5173/mcp/authorize',
		token_endpoint: 'http://localhost:5173/mcp/token',
		registration_endpoint: 'http://localhost:5173/mcp/register',
		jwks_uri: 'http://localhost:5173/mcp/jwks',
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256']
	};
	return { asMetadata, getMcpOAuthConfig: vi.fn(async () => asMetadata) };
});

vi.mock('$lib/server/auth', () => ({
	auth: { api: { getMcpOAuthConfig } }
}));

// Imported after the mock is registered.
import { GET } from './+server';

/** Minimal RequestEvent — the handler reads only `request`. */
function makeEvent(request: Request) {
	return { request } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
	getMcpOAuthConfig.mockClear();
});

describe('GET /.well-known/oauth-authorization-server', () => {
	it('returns 200 JSON AS metadata sourced from the auth instance', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-authorization-server');

		const res = await GET(makeEvent(request));

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');

		const body = await res.json();
		expect(body).toEqual(asMetadata);
		// The RFC 8414 essentials the connector needs.
		expect(body.issuer).toBe('http://localhost:5173');
		expect(body.authorization_endpoint).toBe('http://localhost:5173/mcp/authorize');
		expect(body.token_endpoint).toBe('http://localhost:5173/mcp/token');
		expect(body.registration_endpoint).toBe('http://localhost:5173/mcp/register');
	});

	it('delegates to auth.api.getMcpOAuthConfig with the incoming request', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-authorization-server');

		await GET(makeEvent(request));

		expect(getMcpOAuthConfig).toHaveBeenCalledTimes(1);
		expect(getMcpOAuthConfig).toHaveBeenCalledWith(
			expect.objectContaining({ request, asResponse: false })
		);
	});
});
