// OAuth 2.0 Protected Resource Metadata (RFC 9728) — the discovery document a
// connector fetches to learn which authorization server(s) guard this resource
// (ADR-0010 §Decision(2), ADR-0009, ADR-0001).
//
// This route is the target the `/mcp` 401 points at: `handleMcpPost` emits
// `WWW-Authenticate: Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`
// (`$lib/server/mcp/errors.ts`), so this document MUST live at exactly
// `RESOURCE_METADATA_PATH` (`/.well-known/oauth-protected-resource`). A missing or
// mismatched path is the most common connector-auth failure (ADR-0009), so
// `server.test.ts` asserts the route's on-disk path equals that constant — the two
// can never silently drift.
//
// Deliberately thin: `oAuthProtectedResourceMetadata(auth)` (from better-auth's
// `mcp` plugin) returns a ready `(request) => Promise<Response>` serving a 200 JSON
// document sourced from the `auth` instance — `resource`, `authorization_servers`,
// `jwks_uri`, and supported scopes / bearer methods. It touches no DB rows.
//
// Served at the ORIGIN ROOT (not under `/api`): ADR-0001 established `/.well-known/*`
// is reachable at the root on SvelteKit-on-Vercel.

import type { RequestHandler } from './$types';
import { oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';

const handler = oAuthProtectedResourceMetadata(auth);

export const GET: RequestHandler = ({ request }) => handler(request);
