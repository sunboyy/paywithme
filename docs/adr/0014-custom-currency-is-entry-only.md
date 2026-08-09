# ADR-0014 — A custom currency is entry-only, group-scoped, and identified by an opaque code

- **Status:** Proposed
- **Date:** 2026-08-08

## Context

PLAN §7.5.1 pins a **fixed, seeded list of 29 fiat currencies** and states that
both the group settlement currency and a transaction's entry currency must be one
of them. The list is the top 30 by market cap minus BTC, so it covers most of the
world's spending and misses a long tail — NZD, DKK, HUF, LAK, KHR, NGN and ~150
other ISO codes — and by construction it can never cover a **non-monetary unit**
("beers", "rounds", "points") that a group wants to keep score in.

Users are asking for both. This ADR decides how far a user-defined currency
reaches into the ledger.

Three things in the current implementation make this cheaper than it looks:

- **The money core is already exponent-driven.** `parseMinor(input, exponent)` and
  `formatMinor(minor, exponent, grouped)` (`src/lib/money/money.ts`) are exported,
  take an exponent as a parameter, and are unit-tested against exponents that do
  not appear in the seeded data. `symbolPrefix(code, symbol)` already takes the
  symbol as an argument. **No arithmetic has to change.**
- **The entry UI is already registry-shaped.** `TransactionForm.svelte` takes a
  `FormCurrency` descriptor (`{ code, symbol, exponent, name? }`) plus a
  `currencies` list as props, fed from `load` — it does not import the constant.
- **`currencies` is already a table**, with `name` / `exponent` / `symbol` columns,
  seeded from `src/lib/money/currencies.ts` by migration `0003`.

And four make it non-trivial:

- `getCurrency()` is a **synchronous lookup over a module constant**, and
  `formatAmount` / `parseAmount` / `sanitizeAmountInput` take a bare code and
  re-resolve through it. A code that isn't in the constant throws.
- `CurrencyCode` is a **compile-time literal union** derived from that constant,
  and `currencyCodeSchema` is a `z.enum` over it (`src/lib/schemas/currency.ts`) —
  the single validation gate, shared by client and server.
- `currencies.code` is the **primary key**, and `transactions.currency` holds a
  real foreign key to it. Per-group codes are not unique, so the PK is in the way.
- `list_currencies` is documented as un-wrapped **precisely because** nothing in it
  is member-authored. A user-chosen name and symbol are member-authored (see
  `CONTEXT.md`), which drags in ADR-0003 / ADR-0004.

## Decision

**1. A custom currency is an entry currency only. It can never be a group's
settlement currency.** `groups.settlement_currency` stays restricted to the 29
seeded codes, so `currencyCodeSchema` keeps guarding it unchanged. Every amount
§8 reads — `transaction_shares.amount_owed`,
`transaction_payers.amount_paid_settlement`, `amount_total_settlement` — remains
denominated in a seeded currency. `lib/server/balances.ts`, settle-up, and the
§6.4 currency lock are untouched by this feature.

**2. A custom currency belongs to one group.** It is defined inside a group by a
member of that group and is usable only there. Group membership is already the
authorization boundary (§12), so this adds no new permission concept.

**3. It lives in the existing `currencies` table, keyed by an opaque code.** Add
`group_id` (nullable — `NULL` marks the 29 seeded rows), `display_code`,
`created_by`, `created_at`, and a unique index on `(group_id, display_code)`.
For seeded rows `code == display_code`. For a custom row `code` is a **generated,
globally unique, opaque** string and `display_code` is what the user typed
(`BEER`). `code` remains the primary key.

This is the load-bearing detail: `transactions.currency → currencies.code` keeps
working with no FK surgery, every existing join and query is unchanged, and
per-group uniqueness of the _user-visible_ code is enforced by an index rather
than by the PK. Nothing in the ledger has to learn that two kinds of currency
exist.

**4. Money helpers accept a resolved currency descriptor.** `formatAmount`,
`parseAmount` and `sanitizeAmountInput` gain an overload taking
`{ code, display_code, exponent, symbol }` instead of only a code; `symbolPrefix`
prefixes `display_code`, never the opaque `code`. A **custom currency always
disambiguates its symbol** — the static `SYMBOL_IS_UNIQUE` map is computed over a
closed set and a user-chosen symbol cannot be assumed unique (nor assumed not to
be `$`).

**5. `exponent` and `display_code` freeze on first reference; `name` and `symbol`
stay editable.** Once any transaction references the row, changing its exponent
would silently reinterpret every stored minor-unit amount against it — the same
hazard §6.4 locks the settlement currency against, and the same remedy.

**6. A custom currency is always foreign, so a rate is always required.** It can
never equal the settlement currency, so §7.6's rate-1 same-currency seam never
applies to it and the FX field is always shown. `exchange_rate` is
`numeric(18,6)`, so `1 BEER = 250.000000 THB` is expressible.

**7. Agent writes are unchanged; _reads_ must map and wrap.** Assistant writes are
already restricted to the group settlement currency, so `create_transaction` /
`update_transaction` / `settle_up` never accept a custom code and
`list_currencies` can stay the global seeded table. But **reads return any
transaction**, so `toMcpMoney` and the REST money DTO would otherwise emit the
opaque `code`. Both must resolve `display_code`, and because `display_code` /
`name` / `symbol` are member-authored they are wrapped per ADR-0003 / ADR-0004
wherever they reach an agent.

**8. `/api/v1` speaks `display_code` in _both_ directions; the opaque `code` never
leaves the server.** (Amends decision 7, which originally said API writes were
unchanged too — see "Amendment: REST writes accept a display code" below.) A
transaction write body carries the **display code**, resolved server-side against
the group already named in the URL path; and a new group-scoped
`GET /groups/{gid}/currencies` lists that group's usable currencies by display
code so a client can discover one it has not already seen on a transaction. The
global `GET /currencies` stays the static seeded table, unchanged.

This is deliberately **REST-only**. The Connector is not affected: assistant
writes remain settlement-currency-only by decision 1, which is a restriction on
_which currencies an agent may write in_, not on vocabulary.

## Why not let a custom currency be the settlement currency

This is the option that actually delivers "our group's ledger is denominated in
beers", and it was rejected for v1 on cost and blast radius, not on principle.

It would put user-authored data underneath **every** amount §8 reads. The balance
engine, the greedy settle-up matcher, the group and balance MCP views, the REST
balance DTO and the §6.4 lock would all need to resolve a per-group currency
before they could format anything, and the exponent-immutability rule in decision
5 would stop being a guard rail and become load-bearing for the integrity of
existing balances. It also makes the "custom currency" and "settlement currency"
concepts collide in `groups.settlement_currency`, which today is a plain text
column with no FK.

Entry-only keeps the feature strictly _above_ the ledger's invariants. If the
settlement case is wanted later, this ADR is a step toward it and not away from
it — the table, the descriptor-based money helpers and the immutability rule are
all reusable. Revisit rather than reverse.

## Why not a separate `group_currencies` table

The obvious alternative — leave the seeded table immutable and put custom rows in
their own table — founders on the one FK that matters. `transactions.currency`
points at `currencies.code`; a custom currency living elsewhere means either
dropping that FK and validating in application code (losing the integrity
guarantee for the column that decides how every amount on the row is interpreted),
or adding a second nullable `group_currency_id` column with an XOR check
constraint and teaching every read path to follow whichever of the two is
populated. One nullable `group_id` on the existing table is strictly less
machinery for the same result.

## Why not per-user or account-wide currencies

Reusing one definition across every group a user belongs to sounds like a
convenience and buys a question the group-scoped model never has to answer: what
happens to a group's transactions when the person who defined their currency
leaves, and who may edit a definition that other people's amounts depend on.
Group-scoped ownership makes the row's lifetime match the lifetime of the data
that references it. A user in three groups defining `BEER` three times is an
acceptable cost.

## Why not just seed all of ISO 4217

Expanding the seeded list to every ISO code is nearly free — one array, one seed
migration, and the exponent model already handles the 0/2/3-decimal spread — and
it would answer every request of the form "my country's currency is missing"
without any of this ADR's machinery. It is rejected **as a substitute**, not as an
idea: it cannot express a non-monetary unit, which is the half of the request that
needs a decision. The two are complementary, and widening the seeded list stays
the right answer whenever the missing currency is a real one.

## Amendment: REST writes accept a display code

_2026-08-09, issue #68. Adds decision 8; narrows decision 7 to the agent surface._

Decision 7 as first written said API writes needed no change, reasoning from the
Connector: assistant writes are settlement-only, so no write path can encounter a
custom code. That is true of the Connector and **false of `/api/v1`**, which is a
general-purpose client surface with no such restriction. Once reads emitted only
`display_code`, a REST client could read a custom-currency transaction and could
not write one back: `PUT` is full replacement, so `currency` cannot be omitted, and
`display_code` did not validate. The round-trip had worked before only because the
opaque code was leaking — the bug the read fix closed.

The write **plumbing** was never the problem and needs no change:
`createTransaction` / `updateTransaction` already build their entry-currency gate
from the group's own set (`resolveEntryCurrencies`), custom rows included. The gap
was purely the vocabulary on the wire — reads spoke display code, writes demanded
the opaque code, and nothing connected them. Decision 8 is therefore a translation
at the route boundary, not a change to any service.

Two properties make resolving a display code to a row safe, and both are already
enforced: `(group_id, display_code)` is unique and a display code may not shadow a
seeded code, so within one group a display code names **exactly one** currency;
and `display_code` freezes the moment a transaction references it (decision 5), so
for any transaction that exists in a custom currency, the code it was read under
cannot subsequently move. The only mutable window belongs to a currency no
transaction references — and naming it in a write body is what freezes it.

**Why not leave it (app-only editing).** Read-then-write round-tripping is the
defining property of a full-replacement `PUT` resource. Serving a representation
the same endpoint will not accept back is a broken resource regardless of what
this ADR says about writes, and "the web app is the only place this row can be
edited" is a one-way door that gets discovered by a user rather than by us.

**Why not expose the opaque code on a group-scoped endpoint.** It would also let a
client construct a valid write body, and it is the wrong trade: publishing the
opaque code makes an internal identifier a permanent part of the public contract,
so it could never be regenerated, re-formatted or migrated afterwards. It also
re-introduces exactly what decision 7's read fix removed, and leaves the API
speaking two different currency vocabularies depending on the endpoint. The
display code is the identifier the domain already treats as public
(`CONTEXT.md`, "Display code"); the opaque one exists to be invisible.

## Consequences

- **Balances never display in a custom currency.** A group records
  `3 BEER @ 250 THB` and their balance still reads `฿750`. This is the visible
  price of entry-only and should be said plainly in the UI where a custom currency
  is created, because it is the thing a user asking for "custom currency" is most
  likely to have assumed otherwise.
- **A unit with no meaningful exchange rate cannot be recorded.** Decision 6 makes
  a rate mandatory, so a purely notional scoreboard ("12 points") has no home here.
  That is an honest limit of an entry-only design, not an oversight.
- **`CurrencyCode` has to split.** The seeded literal union stays valid for
  settlement currencies, but a transaction's entry currency becomes a
  runtime-validated string. The existing `as CurrencyCode` casts on entry-currency
  values (in `transactions.ts`, `rounding-backfill.ts` and the MCP view layer)
  become false assurances and must be replaced with a distinct type rather than
  left to widen silently.
- **Entry-currency validation becomes a schema factory.** The shared Zod schemas
  can no longer be static module-level enums for the entry currency; they take the
  group's allowed set, which the transaction `load` already has the group id to
  fetch.
- **PLAN §7.5.1 and decision #19 must be amended** — their "both settlement and
  entry currency must be from this list" is the normative statement of the rule
  this ADR changes. §6.4, §7.6, §9 and §16 need the narrower follow-on edits.
- **The seeded 29 remain the default and the floor.** A group that never opens the
  custom-currency UI is unaffected: no new column is populated, no query plan
  changes, and `code == display_code` everywhere.
