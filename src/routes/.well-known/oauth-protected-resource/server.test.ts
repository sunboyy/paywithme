// Unit test for GET /.well-known/oauth-protected-resource (RFC 9728 protected-
// resource metadata, ADR-0010 §Decision(2), ADR-0009).
//
// Two things are asserted:
//
//   1. The route wraps the REAL better-auth helper `oAuthProtectedResourceMetadata
//      (auth)`, whose only dependency on `auth` is one `auth.api.getMCPProtected
//      Resource(...)` call. Mocking `$lib/server/auth` keeps the test hermetic (no
//      DB / env) while exercising the real path — route → real helper → auth.api →
//      200 JSON Response — and asserts the document (resource + authorization_
//      servers) flows through unchanged.
//
//   2. DRIFT GUARD: this route MUST live at exactly `RESOURCE_METADATA_PATH`
//      (`$lib/server/mcp/errors.ts`), because the `/mcp` 401's `WWW-Authenticate:
//      Bearer resource_metadata="…"` points at it (ADR-0009). A mismatched path is
//      the most common connector-auth failure, so we assert the on-disk location of
//      this route (== the dir this test lives in, relative to `src/routes`) equals
//      that constant — the pointer and the document can never silently drift.

import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RESOURCE_METADATA_PATH } from '$lib/server/mcp/errors';

// The metadata the protected-resource endpoint sources from the `auth` instance.
// Shaped like better-auth's real `getMCPProtectedResourceMetadata` output (RFC 9728).
const { prMetadata, getMCPProtectedResource } = vi.hoisted(() => {
	const prMetadata = {
		resource: 'http://localhost:5173',
		authorization_servers: ['http://localhost:5173'],
		jwks_uri: 'http://localhost:5173/mcp/jwks',
		scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
		bearer_methods_supported: ['header']
	};
	return { prMetadata, getMCPProtectedResource: vi.fn(async () => prMetadata) };
});

vi.mock('$lib/server/auth', () => ({
	auth: { api: { getMCPProtectedResource } }
}));

// Imported after the mock is registered.
import { GET } from './+server';

/** Minimal RequestEvent — the handler reads only `request`. */
function makeEvent(request: Request) {
	return { request } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
	getMCPProtectedResource.mockClear();
});

describe('GET /.well-known/oauth-protected-resource', () => {
	it('returns 200 JSON protected-resource metadata sourced from the auth instance', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-protected-resource');

		const res = await GET(makeEvent(request));

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');

		const body = await res.json();
		expect(body).toEqual(prMetadata);
		// The RFC 9728 essentials a connector needs to find the AS.
		expect(body.resource).toBe('http://localhost:5173');
		expect(body.authorization_servers).toEqual(['http://localhost:5173']);
	});

	it('delegates to auth.api.getMCPProtectedResource with the incoming request', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-protected-resource');

		await GET(makeEvent(request));

		expect(getMCPProtectedResource).toHaveBeenCalledTimes(1);
		expect(getMCPProtectedResource).toHaveBeenCalledWith(
			expect.objectContaining({ request, asResponse: false })
		);
	});

	// The pointer/document drift guard: this route's origin-root path (derived from
	// where this test + its `+server.ts` live under `src/routes`) MUST equal the
	// constant the `/mcp` 401 points at (ADR-0009). Change the route location or the
	// constant and this fails loudly.
	it('is served at exactly RESOURCE_METADATA_PATH', () => {
		const routeDir = dirname(fileURLToPath(import.meta.url));
		// `src/routes` — two levels up from `.well-known/oauth-protected-resource`.
		const routesRoot = resolve(routeDir, '../..');
		const servedPath = '/' + relative(routesRoot, routeDir);

		expect(servedPath).toBe(RESOURCE_METADATA_PATH);
		expect(existsSync(resolve(routeDir, '+server.ts'))).toBe(true);
	});
});
