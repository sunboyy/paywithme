// OAuth 2.0 Authorization Server Metadata (RFC 8414) — the discovery document
// Claude.ai fetches to learn how to obtain user-scoped access tokens against this
// app's connector (ADR-0010 §Decision(2), ADR-0018, ADR-0001).
//
// The issuer is the app ORIGIN (`OAUTH_ISSUER` in `auth.ts`), so RFC 8414 puts
// this document at the origin root, not under `/api/auth` where the auth handler
// is mounted. That is why it needs its own route.
//
// Deliberately thin: `oauthProviderAuthServerMetadata(auth)` returns a ready
// `(request) => Promise<Response>` serving the provider's own metadata: issuer,
// authorization / token / registration / jwks endpoints, scopes, grant types and
// PKCE methods. Because `openid` is a supported scope, this is the OIDC variant
// (the same document as `/.well-known/openid-configuration`). It is derived from
// config, so no DB rows are touched.

import type { RequestHandler } from './$types';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { auth } from '$lib/server/auth';

const handler = oauthProviderAuthServerMetadata(auth);

export const GET: RequestHandler = ({ request }) => handler(request);
