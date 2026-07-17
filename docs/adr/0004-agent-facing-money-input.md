# ADR-0004 — Agent-facing money is a decimal string; the server does the exponent math

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

PLAN pins money to **integer minor units, no floats**, with a **per-currency
exponent** stored on the `currencies` row (`THB`/`USD` = 2, `JPY`/`KRW`/`VND` = 0).
`/api/v1` exposes minor units, which is the correct contract for a developer
reading an OpenAPI spec.

An LLM does not read the spec; it pattern-matches the field name against the
user's utterance:

> User: "log 240 baht for lunch"
> Agent: `create_transaction({ amount: 240, currency: "THB" })`
> Recorded: **฿2.40**

A 100× error, silently, in a money ledger. It is _worse_ than a fixed off-by-100,
because the exponent varies by currency — for `JPY`, `amount: 240` is **correct**.
So the agent must look up each currency's exponent and multiply. That is precisely
the kind of arithmetic LLMs get wrong often enough to matter, and it fails
silently: both `240` and `24000` are valid inputs.

This failure needs no attacker and no bug. It is more probable than the injection
attack in ADR-0003.

## Decision

MCP write tools take a **decimal string** plus a currency code. The server parses
it with the existing **`parseAmount(input: string, code: CurrencyCode)`** in
`lib/money` — which already exists and is tested — and produces the minor-unit
integer.

```
TOOL SCHEMA
  amount:   string   // "240.00" | "240" | "1234.5"
  currency: string   // "THB"
  regex-validated: ^\d+(\.\d{1,4})?$   -- no floats, no negatives

SERVER
  minor = parseAmount("240.00", "THB")   // 24000, via the currency's exponent
  reject if the decimal has more places than the exponent allows
```

A decimal **string**, never a float — PLAN's no-floats invariant is untouched, and
parsing happens inside the module that already owns exponent logic.

Tool results **echo the interpretation back** (ADR-0006): _"Recorded THB 240.00
(24000 minor units)."_ A misparse becomes visible in the transcript rather than
buried in the database.

## Consequences

- The agent's job collapses to **echoing what the user said** — the one thing it
  is reliable at. It performs no exponent arithmetic.
- Nearly free: `parseAmount` already exists.
- The MCP contract now _differs_ from the `/api/v1` contract for amounts. This is
  intentional and is the first concrete instance of the divergence formalised in
  ADR-0006. `/api/v1` and its OpenAPI spec are unchanged.
- More decimal places than the currency's exponent permits is a **hard error**, not
  a silent round. `"240.005"` in THB is rejected.
