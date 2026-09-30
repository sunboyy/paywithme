// OpenID Connect Discovery — the OIDC twin of
// `/.well-known/oauth-authorization-server` (ADR-0018). Some clients probe this
// path instead of (or before) the RFC 8414 one, so both are served at the origin
// root, where the issuer (`OAUTH_ISSUER`) says they live.

import type { RequestHandler } from './$types';
import { oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { auth } from '$lib/server/auth';

const handler = oauthProviderOpenIdConfigMetadata(auth);

export const GET: RequestHandler = ({ request }) => handler(request);
