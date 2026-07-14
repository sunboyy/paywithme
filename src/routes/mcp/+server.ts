// `POST /mcp` — the Agent Connector's Streamable-HTTP endpoint (ADR-0001).
//
// Deliberately thin: every decision lives in `$lib/server/mcp` (testable without a
// route), and the transport shape lives here:
//
//   - `POST`  → the JSON-RPC handler (`initialize`, `tools/list`, `tools/call`).
//   - `GET`   → **405**. The spec says a server MUST either open an SSE stream on
//     GET or return 405; we have no server-initiated messages, so 405 it is.
//   - anything else (`DELETE` — the session-teardown call a STATEFUL server would
//     implement, `PUT`, …) → the same 405 via `fallback`. There is no session to
//     delete: no `Mcp-Session-Id` is ever issued (ADR-0001).
//
// Auth is NOT done by `hooks.server.ts` (whose guard is `/api/v1`-only and emits a
// bare 401): this endpoint's 401 must carry `WWW-Authenticate: Bearer
// resource_metadata="…"` (ADR-0009), so `handleMcpPost` authenticates through the
// SHARED `verifyBearerKey` and shapes its own response.

import type { RequestHandler } from './$types';
import { handleMcpPost } from '$lib/server/mcp/handler';
import { mcpMethodNotAllowed } from '$lib/server/mcp/errors';

export const POST: RequestHandler = (event) => handleMcpPost(event);

export const GET: RequestHandler = () => mcpMethodNotAllowed();

export const fallback: RequestHandler = () => mcpMethodNotAllowed();
