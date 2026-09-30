// Unit test for GET /.well-known/openid-configuration (OIDC discovery, ADR-0018).
// Same shape as the RFC 8414 route test: the REAL helper, `auth.api` stubbed.

import { describe, expect, it, vi } from 'vitest';

const { oidcMetadata, getOpenIdConfig } = vi.hoisted(() => {
	const oidcMetadata = {
		issuer: 'http://localhost:5173',
		authorization_endpoint: 'http://localhost:5173/api/auth/oauth2/authorize',
		userinfo_endpoint: 'http://localhost:5173/api/auth/oauth2/userinfo'
	};
	return { oidcMetadata, getOpenIdConfig: vi.fn(async () => oidcMetadata) };
});

vi.mock('$lib/server/auth', () => ({
	auth: { api: { getOpenIdConfig } }
}));

import { GET } from './+server';

describe('GET /.well-known/openid-configuration', () => {
	it('returns 200 JSON OIDC metadata sourced from the auth instance', async () => {
		const request = new Request('http://localhost:5173/.well-known/openid-configuration');

		const res = await GET({ request } as unknown as Parameters<typeof GET>[0]);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(oidcMetadata);
		expect(getOpenIdConfig).toHaveBeenCalledWith(
			expect.objectContaining({ request, asResponse: false })
		);
	});
});
