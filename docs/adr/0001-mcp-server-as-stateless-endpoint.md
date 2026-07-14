# ADR-0001 — Expose paywithme to AI agents via a stateless MCP endpoint

- **Status:** Accepted
- **Date:** 2026-07-14
- **Supersedes:** —

## Context

`/api/v1` (map #11) is callable by any agent with a shell and network egress.
It is **not** reachable from agents whose tool-execution sandbox has no outbound
network, and not reachable at all from hosts with no shell (Claude.ai, Claude
Desktop, ChatGPT connectors).

The distinction that matters is **who opens the socket**. A `curl` from a
sandboxed bash tool is subject to the sandbox's egress policy. An MCP connection
is not made from there: for Claude Code and Cursor the client process opens it,
and for Claude.ai / the Messages API MCP connector Anthropic's infrastructure
opens it. In every case the sandboxed environment makes no network call, so its
egress policy is irrelevant.

A **local (stdio)** MCP server does not help — it runs inside the same sandbox
and inherits the same restriction. The remote/HTTP shape is load-bearing.

## Decision

Serve MCP at **`POST /mcp`** in the same SvelteKit app, over the **Streamable
HTTP** transport, **statelessly**.

The MCP spec (2025-06-18) makes three things optional that we decline:

- **Session IDs** — the server _"MAY assign a session ID at initialization."_ We
  do not. No session store, no sticky routing, no Redis.
- **SSE streams** — for a JSON-RPC request over POST the server _"MUST either
  return `Content-Type: text/event-stream` … or `application/json`."_ We return
  JSON.
- **GET** — the server _"MUST either return `text/event-stream` … or else return
  HTTP 405 Method Not Allowed."_ We return 405; we have no server-initiated
  messages.

The protocol surface therefore reduces to three JSON-RPC methods — `initialize`,
`tools/list`, `tools/call` — over a single request/response POST handler.

`Origin` is validated on every request (spec MUST — DNS-rebinding defense).

The old HTTP+SSE transport (protocol 2024-11-05) is deprecated and is not
implemented.

## Consequences

- Maps cleanly onto Vercel serverless: no long-lived connections, no shared state.
- Tools call `lib/server/` **directly**, exactly as the `/api/v1` route handlers
  do. The MCP layer does not proxy our own REST API over HTTP to ourselves.
- Idempotency (#20), two-tier rate limiting (#21), and `viaKey` audit provenance
  (#22) come along for free — they live in `lib/server`, below the transport.
- The MCP SDK's `StreamableHTTPServerTransport` is **optional**, not required. If
  it fights the serverless runtime, three JSON-RPC methods are hand-implementable.
  **Resolved in #28 — it fights; we hand-rolled.** The SDK transport's entry point
  is `handleRequest(req: IncomingMessage, res: ServerResponse)`: it writes to a
  **Node stream**. A SvelteKit `+server.ts` is handed a Fetch `Request` and must
  **return** a `Response`, so the SDK would only fit behind a fake
  `IncomingMessage` plus a `ServerResponse` that buffers writes back into a
  `Response` (the shim Vercel ships as `mcp-handler`). That adapter is more code —
  and more failure surface — than the thing it adapts, because this ADR has
  already deleted everything the SDK is _for_: no sessions, no SSE, no GET, no
  server-initiated messages. What remains is three request methods over one
  request/response POST. `src/lib/server/mcp/` implements them with **zero new
  dependencies**; the JSON-RPC codec is a pure function and every malformed-input
  branch is unit-tested.
- We can serve `/.well-known/*` at the origin root — unlike Cloudflare Workers or
  Supabase Edge Functions, which the Claude docs call out as painful for exactly
  this reason. This keeps the OAuth path (ADR-0007) open at no cost.
