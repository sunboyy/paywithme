# ADR-0005 — Server-derived idempotency key over a sliding window

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

`/api/v1` creates are idempotent **only when the caller sends an
`Idempotency-Key` header** — `src/lib/server/api/create.ts`: _"Header absent → the
create runs directly (the current at-least-once behavior)."_

In MCP **there is no caller who can send that header.** `tools/call` carries only
the arguments the model generated. The model will not mint and persist a UUID
across a retry, and the transport will not add one.

So the naive `create_transaction` is **at-least-once, into a money ledger**. The
realistic failure is the agent itself, not the network:

> Agent calls `create_transaction`. The response is slow, or errors _after_ the
> write committed, or the agent misreads the result.
> Agent: _"That didn't seem to go through, let me try again."_
> Two ฿240 lunches.

### The domain constraint that rules out a naive content hash

**Duplicate expenses are legitimate and common.** Two ฿60 coffees on the same day,
same group, same title, is normal human behaviour. A pure content hash would
silently swallow the second one, report "already recorded," and quietly under-bill
the user.

The design must distinguish _the same intent, retried_ from _the same expense,
twice_. Time is the only signal available.

## Decision

The MCP layer **derives** an `Idempotency-Key` server-side and routes the create
through the existing `withIdempotency` store (#20) — no new store.

```
key = sha256( keyId | groupId | toolName | canonicalJson(args) | window )
```

- A content-identical create within **~60s** replays instead of re-executing.
- The same expense an hour later creates a **new** transaction, correctly.

**The window must slide, not bucket.** A naive `floor(now / 60s)` is a _bucket_:
a retry straddling a boundary (t=59s, t=61s) lands in different buckets and
duplicates anyway — the exact failure the mechanism exists to prevent. The
implementation checks the **current bucket and the previous one**.

A replay is surfaced in the echo-back, not hidden: _"That transaction was already
recorded 3s ago — not duplicating it."_

## Consequences

- Reuses the idempotency store built in #20. No new persistence.
- ~60s is a **judgement call**, not a derived constant. It is short enough that a
  genuinely repeated purchase gets through and long enough to absorb an agent
  retry. If real usage shows either failure mode, this is the dial.
- A user who _intends_ to record two identical transactions within 60 seconds will
  get one. The echo-back tells them so, and they can vary the title or wait. We
  accept this as the safer failure direction: an under-recorded expense is visible
  and fixable; a silent duplicate charge in a shared ledger causes a dispute.
- Does **not** protect against an agent that retries with _different_ arguments
  (e.g. re-phrasing the title). Nothing can.
