# ADR-0010 — Connector auth: OAuth, via the better-auth `mcp` plugin

- **Status:** Accepted
- **Date:** 2026-07-18
- **Advances:** ADR-0007 (resolves its deferral)

## Context

ADR-0007 deliberately **did not choose** between `static_headers` (bearer) and
OAuth. It shipped Phase 1 — bearer auth against the API-key table — which reached
**Claude Code and Cursor** immediately, and parked the Claude.ai decision until it
was "cheap to make and informed by use." Two facts now decide it.

**1. Claude.ai is the stated destination, and its supported path is OAuth.**
Claude.ai's custom-connector flow discovers the server, **self-registers** a
client, and runs a `Connect → log in → Allow` handshake. Bearer/`static_headers`
on Claude.ai is a **gated beta** (email Anthropic) and — ADR-0007's own words —
"pasting a bearer token is bad product." OAuth is the flow every directory
connector uses and the only ungated route.

**2. The cost side of ADR-0007's table was wrong.** It costed OAuth as a real
project — "RFC 9728 protected-resource metadata, RFC 8414 AS metadata, DCR **or**
CIMD, PKCE S256, refresh-token rotation." But the app's **existing** auth stack —
**better-auth 1.6.18**, already wiring `magicLink` + `passkey` + `apiKey` — ships
the **`mcp` plugin** (built on `oidcProvider`), which implements _all_ of it:

- an OAuth 2.0 authorization server over the **existing user table**;
- **Dynamic Client Registration** (Claude.ai self-registers — no manual client);
- **PKCE S256**, a consent screen, refresh-token rotation;
- the two discovery documents Claude probes — `oAuthDiscoveryMetadata`
  (`/.well-known/oauth-authorization-server`, RFC 8414) and
  `oAuthProtectedResourceMetadata` (`/.well-known/oauth-protected-resource`,
  RFC 9728);
- `withMcpAuth` / `getMcpSession` to validate an OAuth access token on `/mcp`.

The "expensive, hard-to-reverse decision" ADR-0007 deferred is therefore neither
expensive nor a from-scratch build. Its deferral premise no longer holds.

## Decision

**Adopt OAuth for the Claude.ai connector, via the better-auth `mcp()` plugin.**
Do **not** pursue the `static_headers` beta.

Concretely:

1. Add `mcp({ loginPage: "/login" })` to the `betterAuth({ plugins: [...] })`
   array in `src/lib/server/auth.ts`. The issuer/baseURL is the already-configured
   `BETTER_AUTH_URL`, so production needs no new env.
2. Serve the two discovery routes at the origin root (ADR-0001 already established
   `/.well-known/*` is reachable on SvelteKit-on-Vercel): a `+server.ts` returning
   `oAuthDiscoveryMetadata(auth)` and one returning
   `oAuthProtectedResourceMetadata(auth)`.
3. Make `/mcp` accept **either** credential and converge them on **one**
   `ApiKeyPrincipal` (`userId` + scope): try `getMcpSession` (OAuth access token)
   first, fall back to the existing `verifyBearerKey` (API key). The bearer path
   **stays** — it is how Claude Code and Cursor connect (ADR-0007 Phase 1); OAuth
   is added alongside, not in place of it. The tool layer below the transport
   (ADR-0002, ADR-0006) does not change.
4. Map OAuth scopes `read` / `write` onto the existing `read`/`write` permission
   model (`src/lib/server/api/scope.ts`), so a `read`-only Claude.ai connection
   still cannot move money. The consent screen reproduces the conscious
   `read`/`write` choice ADR-0007 valued in the key-minting UI.

The `mcp`/`oidcProvider` plugins add OAuth tables (`oauthApplication`,
`oauthAccessToken`, `oauthConsent`). Following the project's standing pattern for
plugin-owned tables (`api_key`, `rate_limit`), their Drizzle schema is authored
into `src/lib/server/db/auth-schema.ts` with a matching migration. This is the
**only** unavoidable schema cost.

## Consequences

- **Claude.ai is reached with no gating** and the connector becomes
  directory-eligible and shareable — the endgame ADR-0007 named but could not
  reach in Phase 1.
- **Both credential kinds converge on `ApiKeyPrincipal`**, so ADR-0002 (scope-gated
  tool surface), ADR-0006 (view layer), ADR-0009 (error contract) and every tool
  are untouched. This is the exact "validate a credential → resolve a user → run
  the tool" seam ADR-0007 predicted both branches would share.
- **ADR-0009's `WWW-Authenticate: Bearer resource_metadata="…"` now resolves** to a
  live protected-resource document instead of a promise. The handshake it wired
  "from day one" is completed here.
- The **`static_headers` beta email is dropped** from the plan; the deferral in
  ADR-0007 is closed, not left open.
- New DB tables and a consent/login surface are the added attack surface. They are
  better-auth's own, exercised by the same session/CSRF machinery as the rest of
  auth, and gated by the same `BETTER_AUTH_SECRET`.
- Audit provenance (`viaKey`) assumed an API key. OAuth-originated mutations need an
  equivalent actor tag (`viaOAuth` / client id) so `audit_log` still records _how_
  a change entered — called out so review catches any tool that assumes a key.
