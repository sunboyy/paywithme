# Glossary

The project's ubiquitous language. Terms only — no implementation details.

## Settle up

The **action / flow** of squaring debts within a group: the `/groups/[id]/settle`
page shows suggested transfers and each row's "Settle up" button starts recording
one. It names the _activity_, not a data category. The button, nav item, and page
title stay "Settle up".

## Debt settlement

The transfer **category** (`transfer-debt-settlement`) applied to a transaction
that repays a debt, and the default **title** seeded when a transaction is created
via the Settle up flow. Distinct from "Settle up": that is the action, this is the
resulting transaction's category and title. A Transfer is not necessarily a Debt
settlement — other transfer categories are Cash, Bank transfer, and Other.

## Capture

A **record-later placeholder**: "this expense exists, I'll fill in the details
later". Free text plus an optional amount and a date — never payers,
beneficiaries, a split mode, or a rate. A Capture is **not a transaction in a
draft state**; it lives outside the ledger and no balance can see it, until it is
_resolved_ into a real transaction (ADR-0012). Deliberately shallow: if it could
hold splits it would be a second transaction form.

"Capture" is **internal vocabulary**. Nothing user-facing says it — the UI calls
the tray and the count **"Not recorded yet"**. The noun exists to avoid colliding
with "placeholder" (an unlinked member slot) and "pending" (an idempotency row).

## Connector

paywithme as installed **into an AI assistant** — the agent-facing surface, as
opposed to the web app or the REST API. A user connects by supplying a credential;
what the connector can then do is decided entirely by that credential's Key scope.
"Connector" names the installed relationship, not the endpoint that serves it.

## Key scope

The permission carried by an API key: **Read key** or **Write key** (a Write key
can also read). It is the user's own, deliberate choice of exposure, made when the
key is minted — and for a Connector it is the _only_ thing that decides whether an
agent can move money in the ledger. A Read key that attempts a write is refused.

## Member-authored text

Free text in a group written by **someone other than the person reading it** —
group names, member display names, transaction titles, category names. In a
shared-expense app this is most text. It is treated as **untrusted** wherever it
reaches an agent: it may carry instructions aimed at the agent rather than
description aimed at a human, and it is always marked as to who authored it.

## Echo-back

The plain-language restatement a Connector returns after a write: what was
recorded, for how much, and **naming the humans involved** — "Recorded settle-up:
you → Nan Suphaporn, THB 1,200.00." Its purpose is legibility, not confirmation:
it turns a wrong amount or a wrong payee into something the user reads at the
moment it happens, rather than discovers later in the ledger.
