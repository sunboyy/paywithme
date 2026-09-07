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

## Involved

A member is **involved** in a transaction when they are one of its **payers**, one
of its **beneficiaries**, or both — the sense of "show only what relates to me".
Involvement is participation, not a non-zero amount: a beneficiary whose resolved
share works out to zero was still named on the receipt, and is still involved. The
two sides can be named separately — **paid** (a payer) and **owes** (a
beneficiary) — and "either" is their union, never their sum.

## Capture

A **record-later placeholder**: "this expense exists, I'll fill in the details
later". Free text plus an optional amount and a date — never payers,
beneficiaries, a split mode, or a rate. A Capture is **not a transaction in a
draft state**; it lives outside the ledger and no balance can see it, until it is
_resolved_ into a real transaction (ADR-0012). Deliberately shallow: if it could
hold splits it would be a second transaction form.

"Capture" is **internal vocabulary**. Nothing user-facing says it — the UI calls
the tray and the count **"Not recorded yet"**, and _resolving_ one **"Record it"**. The noun exists to avoid colliding
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

## Custom currency

A unit of account **a group defined itself**, because the seeded list doesn't have
it — an unlisted national currency, or something that was never money ("beers").
It is an **entry currency only**: a transaction can be recorded in one, but a
group can never _settle_ in one, so no balance is ever displayed in a custom
currency (ADR-0014). It belongs to the one group that defined it, and its
user-visible code, name and symbol are Member-authored text.

_Avoid_: custom unit, user currency, fake currency, virtual currency.

## Display code

The short code a currency is **shown by** — `THB`, or `BEER` for a Custom currency.
For a seeded currency it is the ISO code and there is nothing else; a Custom
currency additionally carries an internal identifier that is never shown, never
typed and never spoken about to a user. "Display code" is the only currency code
that appears in an interface, a message, or an API request or response — `/api/v1`
speaks it in both directions and resolves it against the group in the path
(ADR-0014 decision 8).

_Avoid_: currency code (ambiguous — say which one), symbol (that's `฿`, not `THB`).

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

## Receiving method

One way a **User** can be paid — a Rail plus that rail's fields (an account
number, a PromptPay proxy, or free text). It is an **instruction for a human**:
the app never moves money, never verifies an account, and never contacts a bank.

It belongs to a user, never to a Member or a group, so an unlinked member slot has
none by construction — the answer to "how do I pay Nan?" when Nan has no account
is an invite link, not data entry.

_Avoid_: payout method (implies a platform disbursing funds — nothing here
disburses anything), payment method (reads as _how you pay_, the opposite
direction), bank account (only one of the rails).

## Receiving profile

A user's **ordered** list of Receiving methods. The order _is_ the preference —
the first one is what the settle screen shows — so there is no separate "default"
flag to contradict it.

## Rail

The payment network a Receiving method rides: Thai bank transfer, PromptPay, or
the catch-all `other`. A rail owns its own fields, validation, display format and
QR encoding, because all four vary by country and none of them generalise
(ADR-0016). A rail is always a **registry entry in code**, never an enum value in
a `switch`, and no rail is privileged over another.

An entry also carries **field descriptors** — the name, label and control of each
of its fields, as plain data. That is what lets the owner's editor build an
add/edit form for a rail it has never heard of, so adding a country stays a new
registry entry and never a change to a screen.

A rail may also carry a **QR encoder**, and most never will: `th_promptpay` has
one, `th_bank_account` has none because no payload a bank and an account number
produce is one a Thai banking app reads, and `other` has nothing to encode
(ADR-0017). A caller asks for a payload and gets one or nothing, without asking
which rail it holds. A code carries an amount but never a name — it proves nothing
about who owns the account, so it never replaces the name check — and it is
**obfuscation, not protection**: the proxy is inside it in plain digits.
