// OAuth 2.0 Authorization Server Metadata (RFC 8414) — the discovery document
// Claude.ai probes at the origin root to learn how to obtain user-scoped access
// tokens against this app's connector (ADR-0010 §Decision(2), ADR-0001).
//
// Deliberately thin: `oAuthDiscoveryMetadata(auth)` (from better-auth's `mcp`
// plugin) returns a ready `(request) => Promise<Response>` that serves a 200 JSON
// document sourced entirely from the configured `auth` instance — issuer +
// authorization / token / registration / jwks endpoints, supported scopes, grant
// types, and PKCE methods. No DB rows are touched (the metadata is derived from
// config), so this route stays build-safe and DB-free.
//
// Served at the ORIGIN ROOT (`/.well-known/oauth-authorization-server`), NOT under
// `/api`: ADR-0001 established `/.well-known/*` is reachable at the root on
// SvelteKit-on-Vercel, which is where RFC 8414 clients look.

import type { RequestHandler } from './$types';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';

const handler = oAuthDiscoveryMetadata(auth);

export const GET: RequestHandler = ({ request }) => handler(request);
