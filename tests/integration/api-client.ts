// HTTP-BOUNDARY client for the `/api/v1` integration suite (issue #25; PLAN §16.10).
//
// The route-colocated `server.test.ts` files exercise each handler with a stubbed
// principal and mocked services. This module is the complementary layer §16.10 asks
// for: a request goes in as a real `Request` (method + path + headers + JSON body),
// through the REAL `hooks.server.ts` auth guard (which calls `verifyApiKey` against
// the real `api_key` table), into the REAL route handler, which calls the REAL
// services against the LOCAL Postgres. Nothing is mocked — a test asserts what an
// agent would actually receive on the wire.
//
// ── Why we compose the two hooks instead of importing `handle` ────────────────
// `handle` is `sequence(resolveSession, apiV1Guard)`, and SvelteKit's `sequence`
// reads its internal per-request store (`get_request_store()`), which only exists
// inside the real server runtime. `hooks.server.ts` exports both hooks
// individually for exactly this reason, so we compose them here in the SAME order
// `sequence` does — `resolveSession` → `apiV1Guard` → the route. The hook logic
// under test (401 gate, principal attachment) is therefore the production code
// verbatim; only SvelteKit's own `sequence` glue is out of frame.
//
// ── Route table ──────────────────────────────────────────────────────────────
// A tiny stand-in for SvelteKit's router: it maps a pathname to the `+server.ts`
// module + the `params` the handler destructures. An `/api/v1/**` path that
// matches nothing falls through to the REAL `[...unknown]` catch-all route (whose
// `fallback` is the conflated 404), exactly like the deployed app.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { auth } from '$lib/server/auth';
import { scopeToPermissions, type ApiScope } from '$lib/server/api/scope';
import { resolveSession, apiV1Guard } from '../../src/hooks.server';
import { db, IT_PREFIX } from './helpers';

/** One entry of the stand-in router: a path pattern + the params it captures. */
interface RouteEntry {
	pattern: RegExp;
	/** Capture-group names, in order — become `event.params`. */
	names: string[];
	load: () => Promise<Record<string, unknown>>;
}

/** Every `/api/v1` route, in specificity order (longest paths first). */
const ROUTES: RouteEntry[] = [
	{
		pattern: /^\/api\/v1\/currencies$/,
		names: [],
		load: () => import('../../src/routes/api/v1/currencies/+server')
	},
	{
		pattern: /^\/api\/v1\/groups$/,
		names: [],
		load: () => import('../../src/routes/api/v1/groups/+server')
	},
	{
		pattern: /^\/api\/v1\/groups\/([^/]+)\/transactions\/([^/]+)\/restore$/,
		names: ['gid', 'txid'],
		load: () => import('../../src/routes/api/v1/groups/[gid]/transactions/[txid]/restore/+server')
	},
	{
		pattern: /^\/api\/v1\/groups\/([^/]+)\/transactions\/([^/]+)$/,
		names: ['gid', 'txid'],
		load: () => import('../../src/routes/api/v1/groups/[gid]/transactions/[txid]/+server')
	},
	{
		pattern: /^\/api\/v1\/groups\/([^/]+)\/transactions$/,
		names: ['gid'],
		load: () => import('../../src/routes/api/v1/groups/[gid]/transactions/+server')
	},
	{
		pattern: /^\/api\/v1\/groups\/([^/]+)\/settle-up$/,
		names: ['gid'],
		load: () => import('../../src/routes/api/v1/groups/[gid]/settle-up/+server')
	},
	{
		pattern: /^\/api\/v1\/groups\/([^/]+)\/members$/,
		names: ['gid'],
		load: () => import('../../src/routes/api/v1/groups/[gid]/members/+server')
	},
	{
		pattern: /^\/api\/v1\/groups\/([^/]+)\/balances$/,
		names: ['gid'],
		load: () => import('../../src/routes/api/v1/groups/[gid]/balances/+server')
	},
	{
		pattern: /^\/api\/v1\/groups\/([^/]+)$/,
		names: ['gid'],
		load: () => import('../../src/routes/api/v1/groups/[gid]/+server')
	}
];

/** The catch-all — any other `/api/v1/**` path (its `fallback` is the 404). */
const CATCH_ALL = () => import('../../src/routes/api/v1/[...unknown]/+server');

/** Resolve a pathname to its module + params, or the catch-all when nothing matches. */
async function matchRoute(
	pathname: string
): Promise<{ mod: Record<string, unknown>; params: Record<string, string> }> {
	for (const route of ROUTES) {
		const m = route.pattern.exec(pathname);
		if (!m) continue;
		const params: Record<string, string> = {};
		route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
		return { mod: await route.load(), params };
	}
	return { mod: await CATCH_ALL(), params: { unknown: pathname } };
}

/** What a boundary call gives back: the wire status, headers and parsed JSON body. */
export interface ApiResponse<T = unknown> {
	status: number;
	headers: Headers;
	/** The parsed JSON body (every `/api/v1` response is JSON — §16.3). */
	body: T;
}

export interface ApiCallOptions {
	/** The PLAINTEXT key → sent as `Authorization: Bearer <key>`. Omit for no header. */
	key?: string;
	/** A JSON request body (serialized here, so the raw bytes are what the route reads). */
	body?: unknown;
	/** The `Idempotency-Key` header (§16.6). */
	idempotencyKey?: string;
	/** Extra/override headers (e.g. a malformed `Authorization`). */
	headers?: Record<string, string>;
}

/**
 * Issue one request at the `/api/v1` HTTP boundary: real hooks → real route →
 * real services → real Postgres. Returns the wire status/headers/body.
 */
export async function apiCall<T = unknown>(
	method: string,
	path: string,
	options: ApiCallOptions = {}
): Promise<ApiResponse<T>> {
	const url = new URL(path, 'http://localhost');

	const headers = new Headers(options.headers ?? {});
	if (options.key !== undefined && !headers.has('authorization')) {
		headers.set('authorization', `Bearer ${options.key}`);
	}
	if (options.idempotencyKey !== undefined) {
		headers.set('Idempotency-Key', options.idempotencyKey);
	}
	const hasBody = options.body !== undefined;
	if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');

	const request = new Request(url, {
		method,
		headers,
		body: hasBody ? JSON.stringify(options.body) : undefined
	});

	// The event SvelteKit would build. Only the fields the hooks/handlers actually
	// read are populated; `params` is filled in by the router stand-in below.
	const event = {
		request,
		url,
		params: {},
		locals: {},
		route: { id: path }
	} as unknown as RequestEvent;

	/** The "route" step of the chain: match the path, then run the method handler. */
	const dispatch = async (resolved: RequestEvent): Promise<Response> => {
		const { mod, params } = await matchRoute(resolved.url.pathname);
		Object.assign(resolved.params, params);
		const handler = (mod[method.toUpperCase()] ?? mod.fallback) as RequestHandler | undefined;
		if (!handler) {
			throw new Error(`No ${method} handler for ${resolved.url.pathname} in the route table`);
		}
		return (await handler(resolved)) as Response;
	};

	// Production hook order (what `sequence(resolveSession, apiV1Guard)` does).
	const response = (await resolveSession({
		event,
		resolve: ((e: RequestEvent) =>
			apiV1Guard({ event: e, resolve: dispatch })) as unknown as Parameters<
			typeof resolveSession
		>[0]['resolve']
	})) as Response;

	const text = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		body: (text ? JSON.parse(text) : undefined) as T
	};
}

// ── API keys (real, minted through the better-auth plugin) ────────────────────

/** A minted key: its row id + the PLAINTEXT secret (returned exactly once). */
export interface TestApiKey {
	id: string;
	key: string;
	name: string;
}

/** Every key id this suite minted — so cleanup can drop their rate-limit rows. */
const mintedKeyIds = new Set<string>();

/**
 * Mint a REAL API key for `userId` through the plugin's server API — the same call
 * `createApiKeyForUser` (#23) makes, with the same `{ api: [...] }` scope encoding
 * the §16.2 write-guard reads back. The plaintext is what a test sends as
 * `Authorization: Bearer`.
 */
export async function mintApiKey(
	userId: string,
	scope: ApiScope,
	name = `${IT_PREFIX}${scope} key`
): Promise<TestApiKey> {
	const created = await auth.api.createApiKey({
		body: { name, userId, permissions: scopeToPermissions(scope) }
	});
	mintedKeyIds.add(created.id);
	return { id: created.id, key: created.key, name: created.name ?? name };
}

/**
 * Back-date a key's `expires_at` so the next `verifyApiKey` sees an EXPIRED key.
 * (The plugin's `expiresIn` has a minimum of a day, so an expired key can only be
 * produced by writing the past directly.)
 */
export async function expireApiKey(keyId: string): Promise<void> {
	await db.execute(
		sql`update api_key set expires_at = now() - interval '1 day' where id = ${keyId}`
	);
}

/** Revoke = DELETE the key row (PLAN §16.2) — exactly what the plugin's revoke does. */
export async function revokeApiKey(keyId: string): Promise<void> {
	await db.execute(sql`delete from api_key where id = ${keyId}`);
}

/**
 * Drop every row this suite's keys own: the class rate-limit counters (keyed
 * `` `${keyId}:${class}` ``, no FK, so they must go explicitly) and the `api_key`
 * rows themselves — which CASCADE their `idempotency_key` rows away. Call BEFORE
 * `cleanupSuiteRows()` (which removes the groups/users). A re-run is then green.
 */
export async function cleanupApiKeyRows(): Promise<void> {
	for (const keyId of mintedKeyIds) {
		await db.execute(sql`delete from api_key_class_rate_limit where key like ${keyId + ':%'}`);
	}
	mintedKeyIds.clear();
	await db.execute(sql`delete from api_key where reference_id like ${IT_PREFIX + '%'}`);
}
