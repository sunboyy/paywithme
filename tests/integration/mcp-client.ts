// HTTP-BOUNDARY client for the `/mcp` Connector suite (issue #28).
//
// The sibling of `./api-client.ts`, and deliberately its mirror image: a request
// goes in as a real `Request` (method + headers + a JSON-RPC body), through the
// REAL `hooks.server.ts` chain, into the REAL `/mcp` route, which authenticates
// against the REAL `api_key` table and calls the REAL `lib/server` services against
// the LOCAL Postgres. Nothing is mocked — a test asserts exactly what Claude Code
// would receive on the wire.
//
// ── Why the hook chain is composed here too ──────────────────────────────────
// `/mcp` authenticates ITSELF (`handleMcpPost` → `verifyBearerKey`), because its
// 401 must carry `WWW-Authenticate` and the `/api/v1` guard's 401 does not
// (ADR-0009). The hooks are therefore a no-op for this path — but we run the
// request through them anyway, in the SAME order `sequence()` does, so the driver
// stays faithful to production: if a hook ever starts touching `/mcp`, these tests
// see it. (`sequence()` itself can't be imported — it reads SvelteKit's per-request
// store, which only exists in the real server runtime. Same reason as `api-client`.)
//
// Keys are minted with `api-client`'s `mintApiKey` and cleaned up by its
// `cleanupApiKeyRows` — one key lifecycle for both suites.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { resolveSession, apiV1Guard } from '../../src/hooks.server';

/** The wire response: status, headers, and the parsed body (`undefined` for a 202). */
export interface McpResponse<T = unknown> {
	status: number;
	headers: Headers;
	body: T;
}

/** A JSON-RPC response envelope, as it arrives. */
export interface JsonRpcWire<R = unknown> {
	jsonrpc?: string;
	id?: string | number | null;
	result?: R;
	error?: { code: number; message: string; data?: unknown };
}

/** An MCP tool result, as it arrives inside `result`. */
export interface ToolResultWire {
	content: { type: string; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** The error envelope an `isError` tool result carries as its text content. */
export interface ToolErrorEnvelope {
	error: { code: string; message: string; details?: unknown };
}

export interface McpCallOptions {
	/** The PLAINTEXT key → sent as `Authorization: Bearer <key>`. Omit for no header. */
	key?: string;
	/** An `Origin` header (the DNS-rebinding check). Omit to send none, as Claude Code does. */
	origin?: string;
	/** Extra / override headers (e.g. a malformed `Authorization`). */
	headers?: Record<string, string>;
	/** A RAW body string, bypassing JSON serialization (for the malformed-JSON case). */
	raw?: string;
}

/** The origin the driver's requests are addressed to (the app's own). */
export const MCP_ORIGIN = 'http://localhost:5173';

/**
 * Issue ONE raw HTTP request at `/mcp` (any method) and return the wire response.
 * `body` is JSON-serialized unless `options.raw` is given.
 */
export async function mcpRequest<T = unknown>(
	method: string,
	body?: unknown,
	options: McpCallOptions = {}
): Promise<McpResponse<T>> {
	const url = new URL('/mcp', MCP_ORIGIN);

	const headers = new Headers(options.headers ?? {});
	if (options.key !== undefined && !headers.has('authorization')) {
		headers.set('authorization', `Bearer ${options.key}`);
	}
	if (options.origin !== undefined) headers.set('origin', options.origin);

	const hasBody = options.raw !== undefined || body !== undefined;
	if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');

	const request = new Request(url, {
		method,
		headers,
		body: hasBody ? (options.raw ?? JSON.stringify(body)) : undefined
	});

	const event = {
		request,
		url,
		params: {},
		locals: {},
		route: { id: '/mcp' }
	} as unknown as RequestEvent;

	/** The "route" step: the REAL `/mcp` route module. */
	const dispatch = async (resolved: RequestEvent): Promise<Response> => {
		const mod = await import('../../src/routes/mcp/+server');
		const handler = ((mod as Record<string, unknown>)[method.toUpperCase()] ??
			mod.fallback) as RequestHandler;
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

/** A monotonic JSON-RPC id, so every request in a run is distinguishable. */
let nextId = 0;

/** POST one JSON-RPC REQUEST (it has an id → it gets a response). */
export function mcpRpc<R = unknown>(
	method: string,
	params?: Record<string, unknown>,
	options: McpCallOptions = {}
): Promise<McpResponse<JsonRpcWire<R>>> {
	nextId += 1;
	return mcpRequest<JsonRpcWire<R>>(
		'POST',
		{ jsonrpc: '2.0', id: nextId, method, ...(params ? { params } : {}) },
		options
	);
}

/** POST one JSON-RPC NOTIFICATION (no id → it must be acknowledged, never answered). */
export function mcpNotify(
	method: string,
	options: McpCallOptions = {}
): Promise<McpResponse<undefined>> {
	return mcpRequest<undefined>('POST', { jsonrpc: '2.0', method }, options);
}

/** Call a tool and return the `tools/call` response. */
export function mcpToolCall(
	name: string,
	args: Record<string, unknown> | undefined,
	options: McpCallOptions
): Promise<McpResponse<JsonRpcWire<ToolResultWire>>> {
	return mcpRpc<ToolResultWire>(
		'tools/call',
		{ name, ...(args ? { arguments: args } : {}) },
		options
	);
}

/** Parse the `{ error: { code, … } }` envelope out of an `isError` tool result. */
export function toolErrorEnvelope(result: ToolResultWire | undefined): ToolErrorEnvelope {
	if (!result?.content?.[0]?.text) throw new Error('not a tool result with text content');
	return JSON.parse(result.content[0].text) as ToolErrorEnvelope;
}
