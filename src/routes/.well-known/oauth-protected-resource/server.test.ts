// Unit test for GET /.well-known/oauth-protected-resource (RFC 9728 protected-
// resource metadata, ADR-0010 §Decision(2), ADR-0018, ADR-0009).
//
// Two things are asserted:
//
//   1. The route hands the request to `auth.handler`, where the `mcp` plugin's
//      `onRequest` hook serves the document. Mocking `$lib/server/auth` keeps the
//      test hermetic (no DB / env). The same handler serves the RFC 9728
//      path-suffixed form `…/oauth-protected-resource/mcp`.
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

// Shaped like the `mcp` plugin's real document for this config.
const { prMetadata, handler } = vi.hoisted(() => {
	const prMetadata = {
		resource: 'http://localhost:5173/mcp',
		authorization_servers: ['http://localhost:5173'],
		bearer_methods_supported: ['header'],
		scopes_supported: ['read', 'write']
	};
	return { prMetadata, handler: vi.fn(async () => Response.json(prMetadata)) };
});

vi.mock('$lib/server/auth', () => ({ auth: { handler } }));

// Imported after the mock is registered.
import { GET } from './+server';
import { GET as GET_SUFFIXED } from './mcp/+server';

/** Minimal RequestEvent — the handler reads only `request`. */
function makeEvent(request: Request) {
	return { request } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
	handler.mockClear();
});

describe('GET /.well-known/oauth-protected-resource', () => {
	it('serves the plugin document via auth.handler', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-protected-resource');

		const res = await GET(makeEvent(request));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(prMetadata);
		expect(handler).toHaveBeenCalledWith(request);
	});

	it('serves the same document at the path-suffixed /mcp form', async () => {
		const request = new Request('http://localhost:5173/.well-known/oauth-protected-resource/mcp');

		const res = await GET_SUFFIXED(makeEvent(request) as Parameters<typeof GET_SUFFIXED>[0]);

		expect(await res.json()).toEqual(prMetadata);
		expect(handler).toHaveBeenCalledWith(request);
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
