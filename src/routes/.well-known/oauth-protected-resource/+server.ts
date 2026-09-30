// OAuth 2.0 Protected Resource Metadata (RFC 9728) — the discovery document a
// connector fetches to learn which authorization server guards `/mcp`
// (ADR-0010 §Decision(2), ADR-0018, ADR-0009, ADR-0001).
//
// This route is the target the `/mcp` 401 points at: `handleMcpPost` emits
// `WWW-Authenticate: Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`
// (`$lib/server/mcp/errors.ts`), so this document MUST live at exactly
// `RESOURCE_METADATA_PATH` (`/.well-known/oauth-protected-resource`). A missing or
// mismatched path is the most common connector-auth failure (ADR-0009), so
// `server.test.ts` asserts the route's on-disk path equals that constant. The
// RFC 9728 path-suffixed form (`…/oauth-protected-resource/mcp`) is served by the
// `mcp/` child route with the same handler.
//
// The `mcp` plugin builds this document itself (`resource`, `authorization_servers`,
// `scopes_supported`, bearer + DPoP support) and serves it from its `onRequest`
// hook when a request for this path reaches `auth.handler`. The handler is
// mounted under `/api/auth`, so this root route hands the request over. No DB
// rows are touched.

import type { RequestHandler } from './$types';
import { auth } from '$lib/server/auth';

export const GET: RequestHandler = ({ request }) => auth.handler(request);
