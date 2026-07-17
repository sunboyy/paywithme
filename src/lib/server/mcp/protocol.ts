// MCP protocol constants + the `initialize` handshake (ADR-0001).
//
// STATELESS by decision: `initialize` returns capabilities and NOTHING else — no
// `Mcp-Session-Id` is minted here or anywhere (ADR-0001), so there is no session
// store, no sticky routing, and a Vercel serverless invocation needs no memory of
// the last one. The client's `initialize` is, in effect, a pure function.
//
// Capabilities advertise `tools` only. `listChanged: false` is honest: the tool
// list is a static registry filtered by the caller's key scope (ADR-0002), and it
// cannot change under a client mid-connection — a DIFFERENT scope means a
// DIFFERENT key, which means a different connection.

/** The MCP protocol version we implement. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Versions we can speak, newest first. We echo the client's requested version
 * when we support it (the spec's negotiation rule) and otherwise answer with our
 * own latest, letting the client decide whether to proceed.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26'];

/** Identity returned in the `initialize` result. */
export const MCP_SERVER_INFO = {
	name: 'paywithme',
	title: 'Pay with me',
	version: '1.0.0'
} as const;

/**
 * Server-level guidance shown to the model. Deliberately short and money-safe:
 * amounts are integer MINOR units (PLAN §7 — no floats anywhere), and a read key
 * simply has no write tools to reach for (ADR-0002).
 */
export const MCP_SERVER_INSTRUCTIONS =
	'Pay with me is a shared-expense tracker. Groups contain members, transactions ' +
	"and balances. All money amounts are integers in the currency's MINOR units " +
	'(e.g. 1250 = 12.50 USD) — never send or infer a decimal amount. The tools you ' +
	'can see depend on the API key in use: a read-only key exposes no tools that ' +
	'move money.';

/**
 * Negotiate the protocol version for an `initialize` (spec: echo the client's
 * version if supported, else reply with ours). Tolerates a missing/garbage value
 * from a client that sends no version.
 */
export function negotiateProtocolVersion(requested: unknown): string {
	return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
		? requested
		: MCP_PROTOCOL_VERSION;
}

/** The `initialize` result object (no session id — ADR-0001). */
export interface InitializeResult {
	protocolVersion: string;
	capabilities: { tools: { listChanged: boolean } };
	serverInfo: typeof MCP_SERVER_INFO;
	instructions: string;
}

/** Build the `initialize` result for the client's requested `protocolVersion`. */
export function initializeResult(params: Record<string, unknown>): InitializeResult {
	return {
		protocolVersion: negotiateProtocolVersion(params.protocolVersion),
		capabilities: { tools: { listChanged: false } },
		serverInfo: MCP_SERVER_INFO,
		instructions: MCP_SERVER_INSTRUCTIONS
	};
}
