# ADR-0018 — Connector OAuth moves to `@better-auth/mcp` (OAuth 2.1 provider)

- **Status:** Accepted
- **Date:** 2026-09-30
- **Supersedes:** ADR-0010's _mechanism_ (the `mcp()` plugin from
  `better-auth/plugins` and its three tables). ADR-0010's _decision_ — OAuth for
  Claude.ai, both credentials converge on one `ApiKeyPrincipal`, `read`/`write`
  consent — stands unchanged.

## Context

better-auth 1.7 removed the `mcp` plugin (and the `oidcProvider` it wrapped) from
`better-auth/plugins`. Its replacement is a separate package, `@better-auth/mcp`,
which is `@better-auth/oauth-provider` (an OAuth 2.1 / OIDC authorization server)
preset for MCP. Upgrading better-auth therefore means adopting it; there is no
compatible path for the old plugin.

The new provider works differently in ways the app depends on:

- **Access tokens are JWTs bound to a resource.** A token requested with
  `resource=<the /mcp URL>` (RFC 8707) is a JWT signed by the `jwt` plugin, with
  `aud` = that URL. It is not stored, so the resource server verifies it against
  the JWKS instead of looking it up. `getMcpSession` is gone.
- **Different tables.** `oauthApplication` becomes `oauthClient`; refresh tokens
  get their own table; scopes are `text[]`; plus `oauthResource`,
  `oauthClientResource`, `oauthClientAssertion`, and the `jwt` plugin's `jwks`.
- **Client registration is off by default**, and the login/consent pages receive
  the authorization request as **signed** query params, which consent posts back
  as `oauth_query`.

## Decision

1. Register `jwt()` and `mcp()` from `@better-auth/mcp` in `auth.ts`, with
   `resource` = `${origin}/mcp`. The jwt **issuer is pinned to the app origin**,
   so RFC 8414 / OIDC discovery lives at the root `/.well-known/*` (next to the
   existing protected-resource route) rather than under `/api/auth`.
2. **Dynamic Client Registration stays on, unauthenticated** — what the old plugin
   did, and how Claude.ai onboards. Client ID Metadata Documents (`@better-auth/cimd`)
   are not adopted yet; they need an app-owned fetcher for client metadata URLs
   (an SSRF surface) and nothing requires them today.
3. `/mcp` verifies the OAuth token **in-process** (`lib/server/mcp/oauth-token.ts`):
   signature against `auth.api.getJwks()`, `iss`, `aud` = the `/mcp` resource,
   `exp`, `typ: at+jwt`, and DPoP binding (RFC 9449) with the database-backed
   replay store. It does not use the plugin's `requireMcpAuth`: that fetches the
   JWKS from ourselves over HTTP and writes its own 401, whereas `/mcp` must fall
   back to the API-key path and keep ADR-0009's 401. A token **without** the
   resource (opaque, userinfo-only) is refused.
4. The old tables are **dropped, not migrated** (`drizzle/0022_oauth_provider.sql`).
   Existing Claude.ai connections reconnect once.
5. The provider seeds the `/mcp` row into `oauth_resource` during plugin `init`,
   inside better-auth's one-shot `$context` promise. A failed seed would break auth
   for the life of the instance, so `deferResourceSeedFailure` in `auth.ts` turns
   that failure into the provider's own "seed on first use" path.

## Consequences

- The Claude.ai flow is `Connect → register → log in → Allow`, as before. The
  consent page now shows the client's registered name and the host it returns to.
  The name is self-reported through DCR, but the return host is checked against
  the registration.
- `/mcp` does no token-table lookup per request, only a JWT check against cached
  keys. Revoking a JWT access token is not possible before it expires (1 hour by
  default); revoking the refresh token stops renewal.
- Signing keys now live in the `jwks` table, encrypted with `BETTER_AUTH_SECRET`.
  **Rotating that secret invalidates the signing key** as well as sessions.
- The `jwt` plugin's session-JWT feature is not used: its `/token` endpoint is in
  `disabledPaths` and the `set-auth-jwt` header is off.
- `deferResourceSeedFailure` depends on the provider treating a "relation does not
  exist" error as "seed later". `auth.test.ts` asserts `$context` resolves with no
  database, so a provider upgrade that changes this fails in CI.
