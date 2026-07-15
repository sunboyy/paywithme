// The tool registry, the scope filter, and the `tools/call` dispatcher
// (ADR-0002, ADR-0009).
//
// ── The registry is the forward-compatible seam ──────────────────────────────
// Issue #28 ships ONE tool (`list_groups`). Everything about the surface that
// #32 (the write tools) will need is already here and already tested: a tool
// declares the SCOPE it requires, and `tools/list` returns a scope-FILTERED list
// (ADR-0002 — an agent that never sees `settle_up` cannot form the intent to call
// it; a 403 arrives only after the model has already decided to move money).
// Adding a write tool later is a registry entry, not a change to this file's logic.
//
// Filtering is DEFENCE IN DEPTH, not the guard: `dispatchToolCall` re-checks the
// scope on every call, so a client that somehow names a tool it was never shown
// still gets `forbidden_scope`.
//
// ── The two error channels, applied (ADR-0009) ───────────────────────────────
//   - UNKNOWN TOOL → a JSON-RPC protocol error (-32602). It is not a domain
//     failure; the tool does not exist, and the MCP spec's own example says so.
//   - EVERYTHING ELSE (bad scope, rate limit, bad arguments, a service throw) →
//     an `isError: true` tool RESULT the agent can read and act on.

import { getApiKeyScope, type ApiScope } from '$lib/server/api/scope';
import { RATE_LIMITS, consumeRateLimit } from '$lib/server/api/rate-limit';
import { JSON_RPC_ERROR_CODES, jsonRpcErrorObject, type JsonRpcErrorObject } from './jsonrpc';
import { mapToolError, mcpRateLimitedResult, toolError } from './errors';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { McpTool, McpToolDefinition, McpToolResult, RegisteredTool } from './types';
import { listGroupsTool } from './tools/list-groups';
import { getGroupTool } from './tools/get-group';
import { listMembersTool } from './tools/list-members';
import { getBalancesTool } from './tools/get-balances';
import { listTransactionsTool } from './tools/list-transactions';
import { getTransactionTool } from './tools/get-transaction';
import { listCurrenciesTool } from './tools/list-currencies';

/**
 * Erase a tool's `Args` generic so heterogeneous tools share one registry list.
 * Parsing is bound to the tool's own schema here, once, so no call site can forget
 * it and no call site can parse with the WRONG tool's schema.
 */
export function registerTool<Args>(tool: McpTool<Args>): RegisteredTool {
	return {
		definition: tool.definition,
		scope: tool.scope,
		rateLimitClass: tool.rateLimitClass,
		invoke: (ctx, rawArgs) => tool.run(ctx, tool.args.parse(rawArgs))
	};
}

/**
 * Every tool the Connector serves. #28 shipped the tracer bullet (`list_groups`);
 * #29 completes the READ surface — all of it projected through the MCP view layer
 * (ADR-0006), so every free-text field an agent sees is an untrusted envelope and
 * every amount is a decimal string.
 *
 * ORDER IS A PROMPT. `tools/list` is emitted in this order, so it reads as the path
 * the agent should walk: find the group → who is in it (and which member is ME) →
 * THE OWED FIGURE → a page of transactions → one transaction's detail → the currency
 * table. `get_balances` sits before BOTH `list_transactions` and `get_transaction`
 * deliberately (ADR-0008): the authoritative owed figure should be the one the model
 * meets FIRST, before the tempting-but-paginated list it would otherwise try to sum.
 *
 * ADR-0002's write tools (`create_transaction`, `settle_up`, …) join this list in #32
 * with `scope: 'write'` and are then automatically hidden from read keys.
 */
export const MCP_TOOLS: readonly RegisteredTool[] = [
	registerTool(listGroupsTool),
	registerTool(getGroupTool),
	registerTool(listMembersTool),
	registerTool(getBalancesTool),
	registerTool(listTransactionsTool),
	registerTool(getTransactionTool),
	registerTool(listCurrenciesTool)
];

/**
 * The tools a key of `scope` may see (ADR-0002). `write ⊇ read`, so a write key
 * sees everything and a read key sees only the read tools.
 */
export function filterToolsByScope(
	scope: ApiScope,
	tools: readonly RegisteredTool[] = MCP_TOOLS
): McpToolDefinition[] {
	return tools
		.filter((tool) => scope === 'write' || tool.scope === 'read')
		.map((tool) => tool.definition);
}

/** Find a registered tool by wire name. */
export function findTool(
	name: unknown,
	tools: readonly RegisteredTool[] = MCP_TOOLS
): RegisteredTool | undefined {
	return tools.find((tool) => tool.definition.name === name);
}

/** The dispatcher's outcome: a tool result, or a JSON-RPC protocol error. */
export type ToolCallOutcome =
	| { kind: 'result'; result: McpToolResult }
	| { kind: 'protocol_error'; error: JsonRpcErrorObject };

/**
 * Run one `tools/call`, guarded in the same ORDER the REST routes guard themselves:
 *
 *   1. the tool must EXIST                     → else -32602 (protocol error);
 *   2. the key's SCOPE must allow it (§16.2)   → else `forbidden_scope`, and the
 *      rate-limit counter is NOT consumed (a denied call must not cost budget —
 *      the same reason `/api/v1` checks the scope before `requireRateLimit`);
 *   3. the TIER-2 limiter (§16.7) is consumed  → else `rate_limited` (read 100/60s,
 *      write 20/60s), the SAME per-key counters `/api/v1` consumes;
 *   4. the ARGUMENTS parse and the tool RUNS. A `ZodError` from the schema and a
 *      throw from the service both land in `mapToolError` — field-level
 *      `validation_error` details for the former, a conflated `not_found` (or an
 *      opaque `internal_error`) for the latter. Nothing escapes as a protocol error.
 */
export async function dispatchToolCall(
	params: Record<string, unknown>,
	principal: ApiKeyPrincipal,
	tools: readonly RegisteredTool[] = MCP_TOOLS
): Promise<ToolCallOutcome> {
	const name = params.name;
	const tool = findTool(name, tools);

	// 1. Unknown tool — a protocol error, not a domain failure.
	if (!tool) {
		return {
			kind: 'protocol_error',
			error: jsonRpcErrorObject(
				JSON_RPC_ERROR_CODES.invalid_params,
				`Unknown tool: ${typeof name === 'string' ? name : JSON.stringify(name ?? null)}`
			)
		};
	}

	// 2. Scope (ADR-0002). `write ⊇ read`, so only a write TOOL can be denied, and
	//    only to a read KEY.
	if (tool.scope === 'write' && getApiKeyScope(principal) !== 'write') {
		return { kind: 'result', result: toolError('forbidden_scope') };
	}

	// 3. Tier-2 rate limit (§16.7).
	const limitClass = tool.rateLimitClass;
	const decision = await consumeRateLimit(principal.keyId, limitClass);
	if (!decision.allowed) {
		const limit = RATE_LIMITS[limitClass];
		return {
			kind: 'result',
			result: mcpRateLimitedResult(
				limitClass,
				limit.max,
				limit.windowMs / 1000,
				Math.ceil(decision.retryAfterMs / 1000)
			)
		};
	}

	// 4. Arguments + the tool itself.
	try {
		const result = await tool.invoke({ principal }, params.arguments ?? {});
		return { kind: 'result', result };
	} catch (err) {
		return { kind: 'result', result: mapToolError(err) };
	}
}
