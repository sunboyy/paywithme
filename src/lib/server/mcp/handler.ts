// The `/mcp` request handler — the whole Streamable-HTTP transport (ADR-0001).
//
// ONE `POST` in, ONE JSON response out. Statelessly:
//
//   - no `Mcp-Session-Id` is ever issued (the spec says a server MAY; we do not),
//     so there is no session store, no sticky routing, no Redis, and a Vercel
//     serverless invocation needs no memory of the last one;
//   - the response is ALWAYS `application/json`, never `text/event-stream` — for a
//     JSON-RPC request over POST the spec lets the server pick, and we have no
//     server-initiated messages to stream;
//   - `GET` is a 405 (the route's business — `mcpMethodNotAllowed`).
//
// The protocol surface is therefore three request methods — `initialize`,
// `tools/list`, `tools/call` — plus the spec's `ping` utility and the
// notifications a client fires and forgets.
//
// ── Order of operations (each step is a test) ────────────────────────────────
//   1. `Origin` — the spec's DNS-rebinding MUST. Refused BEFORE anything is read.
//   2. AUTH — `resolveMcpAuth` (mcp/auth.ts): EITHER an OAuth access token OR an
//      API key, converged on ONE `ApiKeyPrincipal` (ADR-0010 §Decision(3)). OAuth
//      is tried first, the api-key path is the fallback (it is how Claude Code /
//      Cursor connect). A failure is a `401` + `WWW-Authenticate: Bearer
//      resource_metadata="…"` (ADR-0009), never a `200` carrying an error — Claude
//      ignores the header on a `200`. Authentication is HTTP-layer for the whole
//      endpoint, including `initialize`: an unauthenticated caller learns nothing
//      at all, not even the tool list.
//   3. PARSE — malformed JSON / not-a-JSON-RPC-message → `400` with a JSON-RPC
//      error body and a `null` id (there is no id to echo).
//   4. NOTIFICATION (no `id`, e.g. `notifications/initialized`) → `202` + an empty
//      body. The spec REQUIRES this: a notification must never be answered with a
//      JSON-RPC response, and real clients send one immediately after `initialize`.
//   5. DISPATCH. A well-formed request that fails always returns HTTP `200` with a
//      JSON-RPC error (or an `isError` tool result) — that IS the answer; the
//      transport is not broken.

import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';
import { resolveMcpAuth } from './auth';
import { getApiKeyScope } from '$lib/server/api/scope';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import {
	JSON_RPC_ERROR_CODES,
	jsonRpcError,
	jsonRpcErrorObject,
	jsonRpcResult,
	parseJsonRpcMessage,
	type JsonRpcId,
	type JsonRpcRequest,
	type JsonRpcResponse
} from './jsonrpc';
import { mcpForbiddenOrigin, mcpRateLimited, mcpUnauthorized } from './errors';
import { isOriginAllowed, parseAllowedOrigins } from './origin';
import { initializeResult } from './protocol';
import { dispatchToolCall, filterToolsByScope } from './tools';

/** The MCP methods we implement (ADR-0001's three, plus the spec's `ping`). */
const METHODS = {
	initialize: 'initialize',
	toolsList: 'tools/list',
	toolsCall: 'tools/call',
	ping: 'ping'
} as const;

/**
 * Serialize a JSON-RPC payload. `application/json`, ALWAYS — and conspicuously no
 * `Mcp-Session-Id`, which is the statelessness decision made visible on the wire.
 */
function jsonRpcResponse(payload: JsonRpcResponse, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * The origins `/mcp` accepts: the live request origin (so dev, preview and prod
 * each trust themselves without a hard-coded host), the canonical
 * `BETTER_AUTH_URL`, and anything an operator adds to `MCP_ALLOWED_ORIGINS`.
 */
function allowedOrigins(): string[] {
	return [
		...parseAllowedOrigins(env.BETTER_AUTH_URL),
		...parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS)
	];
}

/** Answer one JSON-RPC REQUEST (it has an id, so it gets a response). */
async function handleRequest(
	request: JsonRpcRequest,
	principal: ApiKeyPrincipal
): Promise<JsonRpcResponse> {
	const { id, method, params } = request;

	switch (method) {
		case METHODS.initialize:
			return jsonRpcResult(id, initializeResult(params));

		// The tool list is SCOPE-FILTERED (ADR-0002): `tools/list` is an
		// authenticated, per-request call, so the caller's key — and its scope — is
		// known here. A read key is never shown a tool that moves money.
		case METHODS.toolsList:
			return jsonRpcResult(id, { tools: filterToolsByScope(getApiKeyScope(principal)) });

		case METHODS.toolsCall: {
			const outcome = await dispatchToolCall(params, principal);
			return outcome.kind === 'result'
				? jsonRpcResult(id, outcome.result)
				: jsonRpcError(id, outcome.error);
		}

		// The spec's liveness utility: respond promptly with an empty result.
		case METHODS.ping:
			return jsonRpcResult(id, {});

		default:
			return jsonRpcError(
				id,
				jsonRpcErrorObject(JSON_RPC_ERROR_CODES.method_not_found, `Unknown method: ${method}`)
			);
	}
}

/** Build the `400` for an unparseable / non-JSON-RPC body (no id to echo → `null`). */
function badMessage(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
	return jsonRpcResponse(jsonRpcError(id, jsonRpcErrorObject(code, message, data)), 400);
}

/** Handle `POST /mcp`. The route is a one-liner over this. */
export async function handleMcpPost(event: RequestEvent): Promise<Response> {
	const { request, url } = event;

	// 1. DNS-rebinding defence (spec MUST).
	if (!isOriginAllowed(request.headers.get('origin'), url.origin, allowedOrigins())) {
		return mcpForbiddenOrigin();
	}

	// 2. Auth — HTTP layer, with the `resource_metadata` pointer (ADR-0009).
	// EITHER an OAuth access token OR an API key, converged on one principal
	// (ADR-0010 §Decision(3)); only the api-key fallback rate-limits.
	const verification = await resolveMcpAuth(request);
	if (!verification.ok) {
		// The TIER-1 per-key backstop (§16.7). Practically unreachable on the read
		// surface — the tier-2 read counter (100/60s) trips first — but a valid key
		// that has already blown its combined budget deserves the truthful 429 rather
		// than a misleading 401.
		if (verification.reason === 'rate_limited') {
			return mcpRateLimited(Math.ceil(verification.tryAgainInMs / 1000));
		}
		return mcpUnauthorized(url.origin);
	}

	// 3. Parse.
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return badMessage(null, JSON_RPC_ERROR_CODES.parse_error, 'Invalid JSON in the request body.');
	}

	const message = parseJsonRpcMessage(payload);
	if (message.kind === 'invalid') {
		return badMessage(null, message.error.code, message.error.message, message.error.data);
	}

	// 4. A notification is acknowledged, never answered (spec: 202, empty body).
	if (message.kind === 'notification') {
		return new Response(null, { status: 202 });
	}

	// 5. Dispatch.
	return jsonRpcResponse(await handleRequest(message.request, verification.principal));
}
