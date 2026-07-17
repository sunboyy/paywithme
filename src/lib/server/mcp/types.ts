// Shared MCP wire types (ADR-0001, ADR-0002, ADR-0009).
//
// Kept in their own module so `errors.ts` (which BUILDS tool results) and
// `tools.ts` (which RUNS tools that return them) can both depend on the shapes
// without depending on each other.

import type { z } from 'zod';
import type { ApiScope } from '$lib/server/api/scope';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

/** A block of tool-result content. We only ever emit `text` (JSON-serialized). */
export interface McpTextContent {
	type: 'text';
	text: string;
}

/**
 * An MCP tool result. `isError: true` is the SECOND error channel (ADR-0009): the
 * agent reads the failure AS CONTENT and can self-correct, instead of seeing a
 * broken transport it cannot reason about.
 */
export interface McpToolResult {
	content: McpTextContent[];
	/** The same payload as parsed JSON, for clients that consume structured output. */
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/**
 * The tool annotations Claude reads (ADR-0002: "Every tool declares the
 * `readOnlyHint` / `destructiveHint` annotations Claude requires").
 */
export interface McpToolAnnotations {
	title: string;
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	/** False: this server's world is the caller's own groups, not the open internet. */
	openWorldHint: boolean;
}

/** The tool object as it appears on the wire in a `tools/list` result. */
export interface McpToolDefinition {
	name: string;
	title: string;
	description: string;
	/** JSON Schema for the tool's arguments (draft 2020-12, as MCP requires). */
	inputSchema: Record<string, unknown>;
	annotations: McpToolAnnotations;
}

/** Everything a tool's `run` is given. */
export interface McpToolContext {
	principal: ApiKeyPrincipal;
}

/**
 * A registered tool: its wire definition, the SCOPE it requires (ADR-0002 — this
 * is what `tools/list` filters on and what the dispatcher enforces), a Zod schema
 * for its arguments, and its implementation.
 *
 * `run` calls `lib/server` services DIRECTLY (ADR-0001) — the Connector never
 * proxies our own `/api/v1` over HTTP to ourselves.
 */
export interface McpTool<Args = unknown> {
	definition: McpToolDefinition;
	/** The API-key scope required to see AND to call this tool. */
	scope: ApiScope;
	/** The §16.7 rate-limit class this tool's work belongs to. */
	rateLimitClass: 'read' | 'write';
	args: z.ZodType<Args>;
	run: (ctx: McpToolContext, args: Args) => Promise<McpToolResult>;
}

/**
 * A tool in the REGISTRY, with its `Args` generic erased: the registry is a
 * heterogeneous list, and a tool's argument type is its own business. `invoke`
 * closes over the tool's Zod schema, so parsing and running are one step — and a
 * `ZodError` it throws is caught by the dispatcher's `mapToolError`, becoming the
 * `validation_error` tool result ADR-0009 asks for (rather than a protocol error).
 */
export interface RegisteredTool {
	definition: McpToolDefinition;
	scope: ApiScope;
	rateLimitClass: 'read' | 'write';
	/** Parse `rawArgs` against the tool's schema (throws `ZodError`), then run it. */
	invoke: (ctx: McpToolContext, rawArgs: unknown) => Promise<McpToolResult>;
}
