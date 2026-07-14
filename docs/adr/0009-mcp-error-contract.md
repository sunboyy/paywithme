# ADR-0009 — Auth errors at the HTTP layer; domain errors as `isError` tool results

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

MCP has **two** error channels, and the choice changes agent behaviour:

- **HTTP / JSON-RPC protocol errors** — the agent sees a broken transport. It
  cannot reason about it and may retry blindly.
- **Tool result with `isError: true`** — the agent reads the error *as content* and
  can self-correct ("that member id isn't in this group; let me call
  `list_members` again").

Getting the split wrong has money consequences. A `422` on a bad member id should
be self-correctable content. A `403 forbidden_scope` must be legible and **not**
retried. A `429` must not trigger an immediate retry, or ADR-0005's idempotency
window becomes the only thing standing between us and a duplicate transaction.

## Decision

**Auth failures → HTTP layer.**

```
401 + WWW-Authenticate: Bearer
      resource_metadata="https://<app>/.well-known/oauth-protected-resource"
```

Returned from day one, even on the bearer path (ADR-0007). Claude does **not**
honour `WWW-Authenticate` on a `200`; a missing `resource_metadata` pointer is the
most common cause of *"Couldn't reach the MCP server."*

**Domain errors → `isError: true` tool results**, reusing the **existing envelope
codes verbatim** (`validation_error`, `forbidden_scope`, `rate_limited`,
`key_reused`). They are already machine-readable and already tested; inventing
MCP-specific strings would be gratuitous divergence.

Errors carry explicit retry guidance, because the agent will otherwise invent its
own:

| Code | Content guidance |
| --- | --- |
| `validation_error` | Self-correctable. Say *what* was wrong (e.g. "member `mem_zz` is not an active member of this group"). |
| `forbidden_scope` | *"Do not retry. This key is read-only. Ask the user for a write key."* |
| `rate_limited` | *"Do **NOT** retry immediately."* |

**404 stays conflated.** `/api/v1` deliberately conflates "not found" and "not
yours" for groups the key cannot see. The MCP layer **must not** un-conflate this
by leaking a distinguishable forbidden-vs-missing signal into tool content — that
would be an existence oracle and a security regression.

## Consequences

- The agent can recover from its own mistakes (bad ids, bad filters) without a
  round-trip through the user.
- The OAuth path (ADR-0007) is wired from day one at zero cost.
- Every new tool must classify its failures into these two channels deliberately.
  The default of "throw and let it become a protocol error" is wrong and must be
  caught in review.
- Retry guidance in error text is a **prompt**, not an enforcement. ADR-0005's
  idempotency window remains the actual protection against a retried write.
