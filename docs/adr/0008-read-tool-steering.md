# ADR-0008 — `get_balances` is the only authoritative source of an owed figure

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

The most likely way paywithme-via-Claude gives someone a **wrong number** involves
no attacker and no bug:

> User: "how much do I owe in the Japan trip group?"
> Agent: calls `list_transactions`. Gets a page and a `nextCursor`. Pages once
> more. Hits context pressure, or decides it has enough.
> Agent sums what it has, converts currencies, announces **"You owe ฿3,400."**
> Truth: **฿9,150.** There were 180 transactions.

`get_balances` — which computes this correctly, server-side, with our money math
and FX rates — was available and unused, because summing a list already in context
*felt* equivalent. The agent states the wrong figure with total confidence and the
user has no reason to doubt it.

## Decision

Make the wrong path hard to prefer. Three levers, all of them:

1. **Steer imperatively in the tool description** — the highest-leverage prompt
   surface available:

   > *"Returns ONE PAGE of a group's transactions (max 25). **DO NOT** compute
   > balances, totals, or 'who owes what' from this list — it is paginated and
   > currency-mixed, and you **will** get the wrong answer. For any owed amount,
   > call `get_balances`, which computes it server-side."*

2. **Make truncation visible** — return **`hasMore`**, so a partial read is
   *visibly* partial rather than plausibly complete, plus a `_note` restating the
   prohibition in the payload itself.

3. **Cap the page at 25**, below REST's default 50 / max 100. The agent does not
   need 100 rows; it needs to know it cannot see them all.

### `hasMore`, not `totalCount`

An exact count was considered and rejected. `listTransactions` returns rows only —
a `totalCount` needs a new filtered `COUNT(*)` and a **second DB round-trip on
every list call**. The route already fetches `limit + 1` to decide whether to mint
a `nextCursor`, so **`hasMore` costs nothing we are not already paying**, and
"this is incomplete" is the entire signal required.

### Rejected

- **Dropping `list_transactions` in v1.** It would make the failure structurally
  impossible, but "what did we spend on food in Tokyo?" is a legitimate question
  and we are not willing to lose it.
- **Mirroring REST's page sizes and descriptions.** Bets that the model reaches for
  `get_balances` unprompted. It will not, reliably.

## Consequences

- **`get_balances` is the single authoritative source of any owed figure.** Any
  future read tool that could tempt a client-side total must carry the same
  steering, or it reopens this hole.
- Page caps and steering language are tuning dials, and should be revisited against
  observed agent behaviour rather than treated as settled.
