# ADR-0007 — Connector auth: bearer now, headers-vs-OAuth decided on evidence

- **Status:** Accepted (the deferral is the decision)
- **Date:** 2026-07-14

## Context

Claude supports six auth types for remote MCP servers. Two are live options:

| | `static_headers` | OAuth (`oauth_dcr` / `oauth_cimd`) |
| --- | --- | --- |
| Build cost | ~zero — our bearer auth already works | Real: RFC 9728 protected-resource metadata, RFC 8414 AS metadata, DCR **or** CIMD, PKCE S256, refresh-token rotation, form-urlencoded token endpoint, 10s endpoint latency budget |
| Availability | **Beta. Gated.** Requires emailing Anthropic | Supported out of the box, today |
| User flow | Mint key → copy → paste into a header field (6 steps, secret on the clipboard) | Click **Connect** → log in → **Allow** |
| Scope choice | User picks `read`/`write` when minting — explicit, legible, and exactly the money-safety decision we want them making | Would need OAuth scopes mapped onto our `read`/`write` model |
| Team/Enterprise | Org-shared credential — wrong shape for a consumer app | Correct |
| Connectors Directory | Not eligible | Required |

The temptation is to call `static_headers` "the cheap path" and stop. That
undersells the trade: **pasting a bearer token is bad product**, and OAuth is the
flow every directory connector uses. The one place headers are genuinely *better*
is scope selection — our key-minting UI already forces a conscious `read`/`write`
choice, which an OAuth consent screen would have to reproduce.

Both paths sit behind the **same tool layer**. Only the auth wrapper differs: both
reduce to *validate a credential → resolve a user → run the tool*.

## Decision

**Do not choose yet. Ship the tool layer first.**

1. **Phase 1** — `POST /mcp` with bearer auth against the existing API-key table
   (#23). Immediately usable in **Claude Code and Cursor**, which accept a static
   header on a remote MCP server today. Real usage, zero gating.
2. **In parallel** — email Anthropic for `static_headers` beta access.
3. **Decide** once we know (a) whether the beta is available, and (b) whether the
   tool surface is even right, having actually used it.

Regardless of path, Phase 1 returns **`401` with
`WWW-Authenticate: Bearer resource_metadata="…"`** on auth failure (ADR-0009). It
costs nothing now and is the exact handshake Claude needs if we go OAuth — the
docs are emphatic that Claude does **not** honour `WWW-Authenticate` on a `200`,
and that a missing `resource_metadata` pointer is the most common cause of
*"Couldn't reach the MCP server."*

## Consequences

- The expensive, hard-to-reverse decision is deferred until it is **cheap to make
  and informed by use**. Nothing in Phase 1 is thrown away on either branch.
- Claude.ai — the stated first target — is **not** reached in Phase 1. Accepted:
  Claude Code/Cursor already solve the originating sandbox problem, and shipping
  the tool layer is the prerequisite for both endgames.
- If the beta is denied, OAuth is the only route to Claude.ai. That is a known,
  bounded, well-specified project, not an unknown.
- SvelteKit on Vercel can serve `/.well-known/*` at the root, so the OAuth branch
  stays open at no structural cost (ADR-0001).
