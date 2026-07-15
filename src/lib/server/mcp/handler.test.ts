// Unit tests for the `/mcp` transport (ADR-0001, ADR-0009).
//
// These drive `handleMcpPost` with a REAL `Request` and assert what an MCP client
// receives on the wire — status, headers and JSON-RPC body — with `verifyApiKey`,
// the rate-limit counter and the groups service mocked (the real-DB version of the
// same journey lives in `tests/integration/mcp-boundary.test.ts`).
//
// The transport invariants under test are the ones ADR-0001 pins down and every
// later ticket inherits: no session id, ever; `application/json`, never
// `text/event-stream`; a notification is acknowledged, not answered; and a
// well-formed-but-failing request is still a `200` — the transport is not broken
// just because the call was wrong.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { verifyApiKey, getSession, consumeRateLimit, listGroupsForUser } = vi.hoisted(() => ({
	verifyApiKey: vi.fn(),
	getSession: vi.fn(),
	consumeRateLimit: vi.fn(),
	listGroupsForUser: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({ auth: { api: { verifyApiKey, getSession } } }));
vi.mock('$lib/server/api/rate-limit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/api/rate-limit')>()),
	consumeRateLimit
}));
vi.mock('$lib/server/groups', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/groups')>()),
	listGroupsForUser
}));

// Imported after the mocks are registered.
import { handleMcpPost } from './handler';
import { MCP_PROTOCOL_VERSION } from './protocol';

const ORIGIN = 'http://localhost:5173';

/** A verified read key, as `verifyApiKey` returns it. */
const VALID_KEY = {
	valid: true,
	key: {
		id: 'key_1',
		name: 'Claude Code',
		referenceId: 'user_1',
		permissions: { api: ['read'] }
	}
};

interface PostOptions {
	key?: string | null;
	origin?: string;
	/** A RAW body string — for the malformed-JSON case. */
	raw?: string;
}

/** The wire shapes these tests assert on (a JSON-RPC response, or an error envelope). */
interface WireToolResult {
	isError?: boolean;
	content?: { type: string; text: string }[];
	structuredContent?: { groups?: Record<string, unknown>[] };
}
interface WireResult extends WireToolResult {
	protocolVersion?: string;
	tools?: { name: string; annotations: Record<string, boolean> }[];
}
interface WireBody {
	jsonrpc?: string;
	id?: string | number | null;
	result?: WireResult;
	error?: { code: number | string; message: string; data?: unknown };
}

/** POST one JSON-RPC message at `/mcp` and read the wire response back. */
async function post(
	message: unknown,
	{ key = 'pwm_valid', origin, raw }: PostOptions = {}
): Promise<{ status: number; headers: Headers; body: WireBody }> {
	const url = new URL('/mcp', ORIGIN);
	const headers = new Headers({ 'content-type': 'application/json' });
	if (key) headers.set('authorization', `Bearer ${key}`);
	if (origin) headers.set('origin', origin);

	const request = new Request(url, {
		method: 'POST',
		headers,
		body: raw ?? JSON.stringify(message)
	});
	const response = await handleMcpPost({ request, url } as RequestEvent);
	const text = await response.text();

	return {
		status: response.status,
		headers: response.headers,
		body: (text ? JSON.parse(text) : {}) as WireBody
	};
}

/** A `tools/call` message. */
function call(name: string, args?: Record<string, unknown>) {
	return { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } };
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyApiKey.mockResolvedValue(VALID_KEY);
	consumeRateLimit.mockResolvedValue({
		allowed: true,
		count: 1,
		lastRequest: Date.now(),
		retryAfterMs: 0
	});
	listGroupsForUser.mockResolvedValue([]);
});

describe('auth (ADR-0009: the 401 must carry WWW-Authenticate)', () => {
	it.each([
		['a MISSING Authorization header', null, undefined],
		['an INVALID key', 'pwm_bad', { valid: false, error: { code: 'INVALID_API_KEY' } }],
		['an EXPIRED key', 'pwm_old', { valid: false, error: { code: 'KEY_EXPIRED' } }],
		['a REVOKED key', 'pwm_gone', { valid: false, error: { code: 'KEY_NOT_FOUND' } }]
	])('%s → 401 + resource_metadata', async (_label, key, verifyResult) => {
		if (verifyResult) verifyApiKey.mockResolvedValue(verifyResult);

		const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { key });

		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
		);
		// One generic body for every failure — no enumeration signal.
		expect(res.body).toEqual({
			error: { code: 'unauthorized', message: 'Authentication required.' }
		});
	});

	it('authenticates even `initialize` — an anonymous caller learns nothing', async () => {
		verifyApiKey.mockResolvedValue({ valid: false, error: { code: 'INVALID_API_KEY' } });
		const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(res.status).toBe(401);
	});

	it('the TIER-1 backstop surfaces as a 429, not a misleading 401', async () => {
		verifyApiKey.mockResolvedValue({
			valid: false,
			error: { code: 'RATE_LIMITED', details: { tryAgainIn: 30_000 } }
		});

		const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });

		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('30');
		expect(res.body.error?.code).toBe('rate_limited');
	});
});

describe('Origin validation (the spec MUST — DNS-rebinding defence)', () => {
	it('rejects a foreign Origin with a 403, before doing any work', async () => {
		const res = await post(
			{ jsonrpc: '2.0', id: 1, method: 'initialize' },
			{ origin: 'https://evil.example' }
		);

		expect(res.status).toBe(403);
		// Not even the key was looked at.
		expect(verifyApiKey).not.toHaveBeenCalled();
	});

	it('accepts the app’s own Origin, and an absent one (Claude Code sends none)', async () => {
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: ORIGIN })).status).toBe(
			200
		);
		expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
	});
});

describe('initialize', () => {
	it('answers with our capabilities and NO session id (ADR-0001: stateless)', async () => {
		const res = await post({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} }
		});

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'paywithme' }
			}
		});
		// The statelessness decision, made visible on the wire.
		expect(res.headers.get('mcp-session-id')).toBeNull();
		// JSON, never a stream.
		expect(res.headers.get('content-type')).toBe('application/json');
	});
});

/** The whole READ surface, in the order `tools/list` advertises it (#29). */
const READ_TOOLS = [
	'list_groups',
	'get_group',
	'list_members',
	'get_balances',
	'list_transactions',
	'get_transaction',
	'list_currencies'
];

describe('tools/list (ADR-0002: scope-filtered)', () => {
	it('advertises the whole READ surface to a read key, all of it read-only', async () => {
		const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

		const tools = res.body.result?.tools ?? [];
		expect(tools.map((t) => t.name)).toEqual(READ_TOOLS);
		expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
	});

	it('a WRITE key sees the same list today (no write tools ship in #29)', async () => {
		verifyApiKey.mockResolvedValue({
			...VALID_KEY,
			key: { ...VALID_KEY.key, permissions: { api: ['read', 'write'] } }
		});

		const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		expect((res.body.result?.tools ?? []).map((t) => t.name)).toEqual(READ_TOOLS);
	});
});

describe('tools/call', () => {
	it('resolves `list_groups` through the real service, for the KEY’s owner', async () => {
		listGroupsForUser.mockResolvedValue([
			{
				id: 'grp_1',
				name: 'Trip',
				settlementCurrency: 'USD',
				createdBy: 'user_1',
				createdAt: new Date('2026-07-01T10:00:00.000Z'),
				deletedAt: null
			}
		]);

		const res = await post(call('list_groups'));

		expect(listGroupsForUser).toHaveBeenCalledWith('user_1');
		expect(res.status).toBe(200);
		expect(res.body.result?.isError).toBeUndefined();
		// Through the MCP VIEW (ADR-0006): the group NAME is Member-authored text, so it
		// arrives inside the untrusted envelope, attributed to its author (ADR-0003).
		expect(res.body.result?.structuredContent?.groups?.[0]).toMatchObject({
			id: 'grp_1',
			name: { _untrusted: true, value: 'Trip', author: { kind: 'you', userId: 'user_1' } }
		});
	});

	it('an unknown TOOL is a JSON-RPC error on a 200 (the transport is fine)', async () => {
		const res = await post(call('drop_database'));

		expect(res.status).toBe(200);
		expect(res.body.error?.code).toBe(-32602);
		expect(res.body.id).toBe(9);
	});

	it('a DOMAIN failure is an isError RESULT, not a JSON-RPC error (ADR-0009)', async () => {
		listGroupsForUser.mockRejectedValue(new Error('boom'));
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await post(call('list_groups'));

		expect(res.status).toBe(200);
		expect(res.body.error).toBeUndefined();
		expect(res.body.result?.isError).toBe(true);
		expect(JSON.parse(res.body.result?.content?.[0].text ?? '{}').error.code).toBe(
			'internal_error'
		);
		spy.mockRestore();
	});
});

describe('protocol errors', () => {
	it('malformed JSON → 400 parse_error with a null id', async () => {
		const res = await post(undefined, { raw: '{ not json' });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32700, message: 'Invalid JSON in the request body.' }
		});
	});

	it('a non-JSON-RPC body → 400 invalid_request', async () => {
		const res = await post({ hello: 'world' });

		expect(res.status).toBe(400);
		expect(res.body.error?.code).toBe(-32600);
	});

	it('an unknown METHOD → -32601 on a 200', async () => {
		const res = await post({ jsonrpc: '2.0', id: 5, method: 'resources/list' });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: 5, error: { code: -32601 } });
	});
});

describe('notifications', () => {
	it('`notifications/initialized` is ACKNOWLEDGED with 202 and an empty body', async () => {
		const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		// The spec forbids answering a notification with a JSON-RPC response.
		expect(res.status).toBe(202);
		expect(res.body).toEqual({});
	});
});
