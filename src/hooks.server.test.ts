import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// Mock the auth module so `auth.api.getSession` / `auth.api.verifyApiKey` are
// spies: no DB / network. `vi.hoisted` lets the spies exist before the hoisted
// `vi.mock` factory runs.
const { getSession, verifyApiKey } = vi.hoisted(() => ({
	getSession: vi.fn(),
	verifyApiKey: vi.fn()
}));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { getSession, verifyApiKey } }
}));

// Imported after the mock is registered.
import {
	handle,
	handleError,
	csrfGuard,
	resolveSession,
	apiV1Guard,
	extractBearerKey
} from './hooks.server';

/**
 * Minimal fake RequestEvent: only the bits the hooks touch (`request`, `url`,
 * `locals`). `path` defaults to a browser route; `headers` seeds the request.
 */
function makeEvent(path = '/', headers?: Record<string, string>): RequestEvent {
	const url = new URL(`http://localhost${path}`);
	return {
		url,
		request: new Request(url, { headers }),
		locals: {} as App.Locals
	} as RequestEvent;
}

/**
 * Like `makeEvent` but lets a test set the request method + body so `csrfGuard`
 * sees a real mutating request with a content type.
 */
function makePost(
	path = '/',
	{ method = 'POST', headers }: { method?: string; headers?: Record<string, string> } = {}
): RequestEvent {
	const url = new URL(`http://localhost${path}`);
	return {
		url,
		request: new Request(url, { method, headers, body: 'a=b' }),
		locals: {} as App.Locals
	} as RequestEvent;
}

describe('extractBearerKey', () => {
	it('strips the Bearer scheme and returns the raw key', () => {
		expect(extractBearerKey('Bearer pwm_test_abc123')).toBe('pwm_test_abc123');
	});

	it('matches the scheme case-insensitively', () => {
		expect(extractBearerKey('bearer pwm_test_abc123')).toBe('pwm_test_abc123');
		expect(extractBearerKey('BEARER pwm_test_abc123')).toBe('pwm_test_abc123');
	});

	it('tolerates surrounding / extra internal whitespace', () => {
		expect(extractBearerKey('  Bearer   pwm_test_abc123  ')).toBe('pwm_test_abc123');
	});

	it('returns null for a missing header', () => {
		expect(extractBearerKey(null)).toBeNull();
		expect(extractBearerKey(undefined)).toBeNull();
		expect(extractBearerKey('')).toBeNull();
	});

	it('returns null for a malformed / wrong-scheme header', () => {
		expect(extractBearerKey('pwm_test_abc123')).toBeNull(); // no scheme
		expect(extractBearerKey('Basic pwm_test_abc123')).toBeNull(); // wrong scheme
		expect(extractBearerKey('Bearer')).toBeNull(); // scheme only
		expect(extractBearerKey('Bearer    ')).toBeNull(); // empty credential
	});
});

describe('csrfGuard (same-origin CSRF guard)', () => {
	const FORM = 'application/x-www-form-urlencoded';

	it('403s a cross-origin form POST to an app route', async () => {
		const event = makePost('/groups', {
			headers: { 'content-type': FORM, origin: 'https://evil.example' }
		});
		const resolve = vi.fn();

		const response = await csrfGuard({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		expect(await response.text()).toContain('forbidden');
	});

	it('403s a form POST with NO Origin header (missing != same-origin)', async () => {
		const event = makePost('/groups', { headers: { 'content-type': FORM } });
		const resolve = vi.fn();

		const response = await csrfGuard({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
	});

	it('allows a same-origin form POST to an app route', async () => {
		const event = makePost('/groups', {
			headers: { 'content-type': FORM, origin: 'http://localhost' }
		});
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await csrfGuard({ event, resolve });

		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('EXEMPTS the better-auth subtree: cross-origin OAuth token POST passes through', async () => {
		// This is the exact request Claude.ai makes — cross-origin, no matching
		// Origin, form-encoded — that SvelteKit used to 403 (the reported bug).
		const event = makePost('/api/auth/mcp/token', {
			headers: { 'content-type': FORM }
		});
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await csrfGuard({ event, resolve });

		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('ignores a cross-origin JSON POST (not a form content type) — e.g. /mcp, /api/v1', async () => {
		const event = makePost('/api/v1/groups', {
			headers: { 'content-type': 'application/json', origin: 'https://claude.ai' }
		});
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await csrfGuard({ event, resolve });

		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('ignores a safe method (GET) regardless of origin', async () => {
		// GET requests carry no body, so build the event with `makeEvent`.
		const event = makeEvent('/groups', { origin: 'https://evil.example' });
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await csrfGuard({ event, resolve });

		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('matches the form content type even with a charset parameter', async () => {
		const event = makePost('/groups', {
			headers: { 'content-type': `${FORM}; charset=utf-8`, origin: 'https://evil.example' }
		});
		const response = await csrfGuard({ event, resolve: vi.fn() });
		expect(response.status).toBe(403);
	});
});

describe('resolveSession (cookie session hook)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('attaches user/session for an authenticated browser request', async () => {
		const user = { id: 'user-1', email: 'a@example.com' };
		const session = { id: 'session-1', userId: 'user-1' };
		getSession.mockResolvedValue({ user, session });

		const event = makeEvent('/');
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await resolveSession({ event, resolve });

		expect(getSession).toHaveBeenCalledTimes(1);
		expect(getSession).toHaveBeenCalledWith({ headers: event.request.headers });
		expect(event.locals.user).toBe(user);
		expect(event.locals.session).toBe(session);
		expect(event.locals.apiKey).toBeNull();
		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('sets locals to null for an anonymous browser request', async () => {
		getSession.mockResolvedValue(null);

		const event = makeEvent('/');
		const resolve = vi.fn().mockResolvedValue(new Response('ok'));

		await resolveSession({ event, resolve });

		expect(event.locals.user).toBeNull();
		expect(event.locals.session).toBeNull();
		expect(event.locals.apiKey).toBeNull();
		expect(resolve).toHaveBeenCalledWith(event);
	});

	it('does not throw and treats the request as anonymous when getSession rejects', async () => {
		getSession.mockRejectedValue(new Error('transient db error'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const event = makeEvent('/');
		const resolve = vi.fn().mockResolvedValue(new Response('ok'));

		await resolveSession({ event, resolve });

		expect(event.locals.user).toBeNull();
		expect(event.locals.session).toBeNull();
		expect(resolve).toHaveBeenCalledWith(event);
		errorSpy.mockRestore();
	});

	it('SKIPS the cookie getSession for /api/v1/* requests', async () => {
		const event = makeEvent('/api/v1/groups', { authorization: 'Bearer pwm_test_key' });
		const resolve = vi.fn().mockResolvedValue(new Response('ok'));

		await resolveSession({ event, resolve });

		expect(getSession).not.toHaveBeenCalled();
		expect(event.locals.user).toBeNull();
		expect(event.locals.session).toBeNull();
		expect(event.locals.apiKey).toBeNull();
		expect(resolve).toHaveBeenCalledWith(event);
	});
});

describe('apiV1Guard (/api/v1 auth gate)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	/** Parse a short-circuited guard Response as the JSON error envelope. */
	async function readEnvelope(res: Response) {
		return {
			status: res.status,
			contentType: res.headers.get('content-type'),
			body: await res.json()
		};
	}

	it('passes non-/api/v1 requests straight through untouched', async () => {
		const event = makeEvent('/groups');
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await apiV1Guard({ event, resolve });

		expect(verifyApiKey).not.toHaveBeenCalled();
		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('short-circuits a generic 401 when the Authorization header is missing', async () => {
		const event = makeEvent('/api/v1/groups');
		const resolve = vi.fn();

		const response = await apiV1Guard({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(verifyApiKey).not.toHaveBeenCalled();
		const { status, contentType, body } = await readEnvelope(response);
		expect(status).toBe(401);
		expect(contentType).toContain('application/json');
		expect(body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
	});

	it('short-circuits a generic 401 for a malformed Authorization header', async () => {
		const event = makeEvent('/api/v1/groups', { authorization: 'Basic not-a-bearer' });
		const resolve = vi.fn();

		const response = await apiV1Guard({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(verifyApiKey).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
	});

	it('collapses an invalid/expired key to a generic 401 and never leaks the plugin code', async () => {
		// The plugin reports a specific internal code — the guard must NOT forward it.
		verifyApiKey.mockResolvedValue({
			valid: false,
			error: { code: 'KEY_EXPIRED', message: 'API key has expired.' },
			key: null
		});

		const event = makeEvent('/api/v1/groups', { authorization: 'Bearer pwm_test_expired' });
		const resolve = vi.fn();

		const response = await apiV1Guard({ event, resolve });

		expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: 'pwm_test_expired' } });
		expect(resolve).not.toHaveBeenCalled();

		const { status, body } = await readEnvelope(response);
		expect(status).toBe(401);
		expect(body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
		// No enumeration signal: the internal code/message never appears in the body.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain('KEY_EXPIRED');
		expect(serialized).not.toContain('expired');
	});

	it('maps the plugin RATE_LIMITED (tier-1) to a 429 envelope + Retry-After — NOT collapsed to 401', async () => {
		// The tier-1 backstop tripped inside verifyApiKey. `tryAgainIn` is MILLISECONDS.
		verifyApiKey.mockResolvedValue({
			valid: false,
			error: {
				code: 'RATE_LIMITED',
				message: 'Rate limit exceeded.',
				details: { tryAgainIn: 30_000 }
			},
			key: null
		});

		const event = makeEvent('/api/v1/groups', { authorization: 'Bearer pwm_test_busy' });
		const resolve = vi.fn();

		const response = await apiV1Guard({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		const { status, contentType, body } = await readEnvelope(response);
		expect(status).toBe(429);
		expect(contentType).toContain('application/json');
		expect(body.error.code).toBe('rate_limited');
		// Combined tier-1 counter → scope 'key', limit 150, 60s window; ceil(30000/1000)=30.
		expect(body.error.details).toEqual({
			scope: 'key',
			limit: 150,
			windowSeconds: 60,
			retryAfterSeconds: 30
		});
		expect(response.headers.get('Retry-After')).toBe('30');
	});

	it('rounds a fractional tryAgainIn UP for both the body and the Retry-After header', async () => {
		verifyApiKey.mockResolvedValue({
			valid: false,
			error: { code: 'RATE_LIMITED', message: 'slow down', details: { tryAgainIn: 1_500 } },
			key: null
		});

		const event = makeEvent('/api/v1/groups', { authorization: 'Bearer pwm_test_busy' });
		const response = await apiV1Guard({ event, resolve: vi.fn() });

		expect(response.status).toBe(429);
		const body = await response.json();
		expect(body.error.details.retryAfterSeconds).toBe(2); // ceil(1500/1000)
		expect(response.headers.get('Retry-After')).toBe('2');
	});

	it('returns a generic 401 (not a 500) when verifyApiKey throws', async () => {
		verifyApiKey.mockRejectedValue(new Error('db blip'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const event = makeEvent('/api/v1/groups', { authorization: 'Bearer pwm_test_x' });
		const resolve = vi.fn();

		const response = await apiV1Guard({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
		errorSpy.mockRestore();
	});

	it('attaches the minimal principal and proceeds for a valid key', async () => {
		verifyApiKey.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: 'key-42',
				name: 'agent key',
				referenceId: 'user-7',
				permissions: { groups: ['read', 'write'] }
			}
		});

		const event = makeEvent('/api/v1/groups', { authorization: 'Bearer pwm_test_good' });
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await apiV1Guard({ event, resolve });

		expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: 'pwm_test_good' } });
		// `name` rides along as AUDIT PROVENANCE only (§16.2) — never as authority.
		expect(event.locals.apiKey).toEqual({
			keyId: 'key-42',
			name: 'agent key',
			userId: 'user-7',
			permissions: { groups: ['read', 'write'] }
		});
		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('normalizes an absent permissions field AND an unnamed key to null on the principal', async () => {
		verifyApiKey.mockResolvedValue({
			valid: true,
			error: null,
			key: { id: 'key-1', referenceId: 'user-1' }
		});

		const event = makeEvent('/api/v1/transactions', { authorization: 'Bearer pwm_test_good' });
		const resolve = vi.fn().mockResolvedValue(new Response('ok'));

		await apiV1Guard({ event, resolve });

		expect(event.locals.apiKey).toEqual({
			keyId: 'key-1',
			name: null,
			userId: 'user-1',
			permissions: null
		});
	});
});

describe('composed handle (sequence)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('exports a composed handle', () => {
		// `handle` is the `sequence(resolveSession, apiV1Guard)` result. Its runtime
		// behavior is asserted below by chaining the two exported hooks in the exact
		// order `sequence` runs them — invoking the real `sequence` output directly
		// requires SvelteKit's per-request store, which only exists inside a live
		// request, not a unit test.
		expect(typeof handle).toBe('function');
	});

	/**
	 * Run `resolveSession` then `apiV1Guard` in the same order `sequence` composes
	 * them: `resolveSession`'s `resolve` is `apiV1Guard`, whose `resolve` is the
	 * real route handler. Proves the end-to-end wiring without SvelteKit internals.
	 */
	function runChain(event: RequestEvent, routeResolve: (e: RequestEvent) => Promise<Response>) {
		return resolveSession({
			event,
			resolve: (innerEvent) => apiV1Guard({ event: innerEvent, resolve: routeResolve })
		});
	}

	it('runs the full session path for a browser route', async () => {
		const user = { id: 'user-1' };
		const session = { id: 'session-1' };
		getSession.mockResolvedValue({ user, session });

		const event = makeEvent('/groups');
		const sentinel = new Response('ok');
		const routeResolve = vi.fn().mockResolvedValue(sentinel);

		const response = await runChain(event, routeResolve);

		expect(getSession).toHaveBeenCalledTimes(1);
		expect(verifyApiKey).not.toHaveBeenCalled();
		expect(event.locals.user).toBe(user);
		expect(event.locals.session).toBe(session);
		expect(routeResolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('for /api/v1/* skips getSession, verifies the key, and attaches the principal', async () => {
		verifyApiKey.mockResolvedValue({
			valid: true,
			error: null,
			key: { id: 'key-9', referenceId: 'user-9', permissions: null }
		});

		const event = makeEvent('/api/v1/groups', { authorization: 'Bearer pwm_test_good' });
		const sentinel = new Response('ok');
		const routeResolve = vi.fn().mockResolvedValue(sentinel);

		const response = await runChain(event, routeResolve);

		expect(getSession).not.toHaveBeenCalled();
		expect(verifyApiKey).toHaveBeenCalledTimes(1);
		expect(event.locals.apiKey).toEqual({
			keyId: 'key-9',
			name: null,
			userId: 'user-9',
			permissions: null
		});
		expect(routeResolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('for /api/v1/* with no key short-circuits a 401 before the route runs', async () => {
		const event = makeEvent('/api/v1/groups');
		const routeResolve = vi.fn().mockResolvedValue(new Response('ok'));

		const response = await runChain(event, routeResolve);

		expect(getSession).not.toHaveBeenCalled();
		expect(verifyApiKey).not.toHaveBeenCalled();
		expect(routeResolve).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
	});
});

describe('handleError (uncaught-error normalizer)', () => {
	/** Minimal error-hook args: only `event.url.pathname` and `message` are read. */
	function makeArgs(path: string, error: unknown = new Error('boom')) {
		return {
			error,
			event: makeEvent(path),
			status: 500,
			message: 'Internal Error'
		} as unknown as Parameters<typeof handleError>[0];
	}

	it('returns the internal_error envelope for an /api/v1/* error and logs it', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = handleError(makeArgs('/api/v1/groups'));
		expect(result).toEqual({ error: { code: 'internal_error', message: expect.any(String) } });
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('never leaks the original error message for an /api/v1/* error', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = handleError(makeArgs('/api/v1/groups', new Error('secret leak here')));
		expect(JSON.stringify(result)).not.toContain('secret leak here');
		errorSpy.mockRestore();
	});

	it('preserves the default { message } shape for non-api routes', () => {
		const result = handleError(makeArgs('/groups'));
		expect(result).toEqual({ message: 'Internal Error' });
	});
});
