// JSON-RPC 2.0 codec for the MCP Connector (ADR-0001).
//
// ── Why hand-rolled rather than the MCP TypeScript SDK ───────────────────────
// ADR-0001 left this open ("try the SDK first; fall back if it fights"). It
// fights. The SDK's `StreamableHTTPServerTransport.handleRequest` is typed
// `(req: IncomingMessage, res: ServerResponse)` — it writes to a Node stream. A
// SvelteKit `+server.ts` is handed a Fetch `Request` and must RETURN a `Response`,
// so the SDK could only be used behind a fake `IncomingMessage` + a
// `ServerResponse` that buffers writes back into a `Response` (the shim Vercel
// ships as `mcp-handler`). That adapter is more code — and more failure surface —
// than the thing it adapts: ADR-0001 already reduces the protocol to THREE
// request methods over a single request/response POST (no sessions, no SSE, no
// GET). So we hand-roll, and this module is the whole wire format.
//
// The parser is PURE (`unknown` → a tagged union) so every malformed-input branch
// is unit-tested without a request. Batching is NOT supported: it was removed from
// the spec in 2025-06-18, so an array is an `invalid_request`.

import { z } from 'zod';

/** The only JSON-RPC version we speak. */
export const JSON_RPC_VERSION = '2.0';

/** The standard JSON-RPC 2.0 error codes we emit (spec §5.1). */
export const JSON_RPC_ERROR_CODES = {
	/** Invalid JSON was received. */
	parse_error: -32700,
	/** The payload is not a valid JSON-RPC request object. */
	invalid_request: -32600,
	/** The method is not one of `initialize` / `tools/list` / `tools/call`. */
	method_not_found: -32601,
	/**
	 * Bad params — for `tools/call` this means an UNKNOWN TOOL NAME (the MCP spec's
	 * own example). A tool that RAN and failed is NOT this: it is a domain error and
	 * comes back as an `isError: true` tool RESULT (ADR-0009).
	 */
	invalid_params: -32602,
	/** An internal JSON-RPC failure. */
	internal_error: -32603
} as const;

/** A JSON-RPC id: string, number, or null. */
export type JsonRpcId = string | number | null;

/** A parsed JSON-RPC request (has an `id`, so it expects a response). */
export interface JsonRpcRequest {
	id: Exclude<JsonRpcId, null>;
	method: string;
	params: Record<string, unknown>;
}

/** A parsed JSON-RPC notification (NO `id`, so it must NOT be responded to). */
export interface JsonRpcNotification {
	method: string;
	params: Record<string, unknown>;
}

/** The JSON-RPC error object. */
export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

/** A JSON-RPC response envelope — exactly one of `result` / `error`. */
export type JsonRpcResponse =
	| { jsonrpc: typeof JSON_RPC_VERSION; id: JsonRpcId; result: unknown }
	| { jsonrpc: typeof JSON_RPC_VERSION; id: JsonRpcId; error: JsonRpcErrorObject };

/**
 * The shape of a single JSON-RPC message on the wire. `id` is present on a
 * request and absent on a notification — the ONE bit that decides whether we
 * answer (a response) or acknowledge (202 + empty body).
 */
const messageSchema = z.object({
	jsonrpc: z.literal(JSON_RPC_VERSION),
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string().min(1),
	params: z.record(z.string(), z.unknown()).optional()
});

/** The result of parsing one wire payload. */
export type ParsedMessage =
	| { kind: 'request'; request: JsonRpcRequest }
	| { kind: 'notification'; notification: JsonRpcNotification }
	| { kind: 'invalid'; error: JsonRpcErrorObject };

/**
 * Parse an already-JSON-decoded payload into a request / notification / invalid.
 * PURE. An array (a pre-2025-06-18 batch) is rejected as `invalid_request` — the
 * spec removed batching, and silently processing one element of a batch would be
 * worse than saying no.
 *
 * A JSON-RPC `id` of `null` is legal in the base spec but MCP forbids it, and it
 * is indistinguishable from a notification; the schema therefore accepts only a
 * string/number id, and `null` lands in `invalid`.
 */
export function parseJsonRpcMessage(payload: unknown): ParsedMessage {
	if (Array.isArray(payload)) {
		return {
			kind: 'invalid',
			error: jsonRpcErrorObject(
				JSON_RPC_ERROR_CODES.invalid_request,
				'JSON-RPC batching is not supported (removed in MCP 2025-06-18). Send one request per POST.'
			)
		};
	}

	const parsed = messageSchema.safeParse(payload);
	if (!parsed.success) {
		return {
			kind: 'invalid',
			error: jsonRpcErrorObject(
				JSON_RPC_ERROR_CODES.invalid_request,
				'Not a valid JSON-RPC 2.0 message.',
				z.flattenError(parsed.error)
			)
		};
	}

	const { id, method, params } = parsed.data;
	if (id === undefined) {
		return { kind: 'notification', notification: { method, params: params ?? {} } };
	}
	return { kind: 'request', request: { id, method, params: params ?? {} } };
}

/** Build a JSON-RPC error OBJECT (not a response). `data` is omitted when absent. */
export function jsonRpcErrorObject(
	code: number,
	message: string,
	data?: unknown
): JsonRpcErrorObject {
	const error: JsonRpcErrorObject = { code, message };
	if (data !== undefined) error.data = data;
	return error;
}

/** Build a JSON-RPC success response for `id`. */
export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: JSON_RPC_VERSION, id, result };
}

/** Build a JSON-RPC error response for `id`. */
export function jsonRpcError(id: JsonRpcId, error: JsonRpcErrorObject): JsonRpcResponse {
	return { jsonrpc: JSON_RPC_VERSION, id, error };
}
