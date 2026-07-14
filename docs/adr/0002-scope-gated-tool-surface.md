# ADR-0002 — The MCP tool surface is gated by the API key's scope

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

PLAN §16.2 already defines a two-scope API-key model in
`src/lib/server/api/scope.ts`: `read` and `write`, with `write ⊇ read`, enforced
by one shared `requireWriteScope` guard on every mutating endpoint. Its own
module comment states the intent:

> a `read` key that attempts a write gets a 403 `forbidden_scope` — the
> high-value money-safety affordance against a leaked or **prompt-injected**
> read key.

`tools/list` is an **authenticated, per-request** MCP call. The caller's key —
and therefore its scope — is known at list time.

## Decision

`tools/list` returns a **scope-filtered** tool list.

| Key scope | Tools advertised |
| --- | --- |
| `read` | `list_groups`, `get_group`, `list_members`, `get_balances`, `list_transactions`, `get_transaction`, `list_currencies` |
| `write` | all of the above **plus** `create_transaction`, `update_transaction`, `delete_transaction`, `restore_transaction`, `settle_up` |

`requireWriteScope` remains the enforcement point — a `read` key that somehow
invoked a write tool still gets `forbidden_scope`. Filtering the list is defence
in depth, not the guard.

Every tool declares the `readOnlyHint` / `destructiveHint` annotations Claude
requires. `delete_transaction` is the one tool marked `destructiveHint: true`.

## Consequences

- A user chooses their own exposure **by choosing which key they paste into the
  connector**. No new mechanism, no new consent surface. The key-minting UI (#23)
  already makes `read` vs `write` a conscious choice at the moment of creation —
  which is exactly where we want that decision made.
- Filtering beats advertising-then-403: an agent that never sees `settle_up`
  cannot form the intent to call it. A 403 arrives *after* the model has already
  decided to move money.
- "Read-only v1" and "full v1" are not separate products. They are the same
  server, behaving differently per key.
- **This does not defend the write-key case.** A user who deliberately pastes a
  write key gets write tools, by design — that is what makes "log my lunch" work,
  and it is the whole point of the connector. Prompt injection against a write
  key is addressed separately in ADR-0003.
