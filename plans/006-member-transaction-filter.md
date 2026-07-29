# Plan 006: Filter transactions by member ("show only what relates to me")

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 9696125..HEAD -- src/lib/server/transactions.ts 'src/routes/groups/[id]/transactions/' 'src/routes/api/v1/groups/[gid]/transactions/' src/lib/server/mcp/tools/list-transactions.ts static/api/v1/openapi.yaml`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (touches the shared list query read by web + REST + MCP)
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `9696125`, 2026-07-29

## Why this matters

`PLAN.md §10` specifies the transaction list as "filter by type/category" only.
In a group of six people over a two-week trip, the list is a hundred rows, and
the question a member actually asks is not "show me all Food & Drink" — it is
**"which of these involve me?"** Today the only way to answer that is to open
each transaction and read its payer/beneficiary lines.

The data to answer it is already stored and already indexed by transaction:
`transaction_payers` (who paid) and `transaction_shares` (who owes — the
resolved, aggregated per-member share, written for every split mode including
itemized). The filter is a pair of `EXISTS` predicates on the existing list
query; nothing about money math, access control, or the balance ledger changes.

**Decided semantics** (user, at planning time): the filter is _selectable_ — a
member plus a role, where role is **paid by** / **for whom** / **both**.

## Scope

**In scope**

1. `listTransactions` gains `memberId` + `memberRole` filters (service layer).
2. Two indexes so the member-first query path is available to the planner.
3. Web UI: member Select + role chips on `/groups/[id]/transactions`.
4. REST: `memberId` + `role` query params on
   `GET /api/v1/groups/{gid}/transactions` (additive), plus OpenAPI spec + the
   regenerated JSON.
5. MCP: `memberId` + `role` args on `list_transactions` (additive).
6. Unit tests at every layer + one real-DB integration test for the SQL.

**Out of scope — do not do these**

- The group overview's "recent transactions" card (`/groups/[id]`). It is a
  fixed 5-row preview; a filter there is a different UX question.
- Any change to balances, settle-up, or the activity feed.
- Persisting the filter (cookie/localStorage). The URL is the state, exactly as
  `type`/`category` are today.
- Filtering by _user_ rather than _member_. The domain unit here is the group
  member (a participant slot that may or may not be linked to a user, `§6.1`).

## Design decisions (settle these before writing code)

### D1 — "Relates to" is row presence, not a non-zero amount

A member "paid" a transaction iff a `transaction_payers` row exists for
`(transactionId, memberId)`; they are a beneficiary iff a `transaction_shares`
row exists. A share of **0** still counts as involvement — the member was named
as a beneficiary, and hiding that row would make the filter lie about who was on
the receipt. Document this in the `TransactionListFilters` doc comment.

### D2 — Param names

Follow the existing per-surface convention rather than forcing one name:

| Surface | Member param | Role param | Precedent                                 |
| ------- | ------------ | ---------- | ----------------------------------------- |
| Web     | `member`     | `role`     | web uses short names (`type`, `category`) |
| REST    | `memberId`   | `role`     | REST uses `categoryId`                    |
| MCP     | `memberId`   | `role`     | MCP mirrors REST                          |

`role` ∈ `paid` \| `owes`. **Absent `role` means both** — the union, which is
the "relates to me" default. Do not invent a third literal (`both`/`any`) on the
wire; absence already expresses it and keeps the URL clean.

Internally the service takes `memberRole?: 'paid' | 'owes'` with `undefined`
meaning the union, so there is exactly one representation of "both".

### D3 — An unknown `memberId` matches nothing; it is not an error

This mirrors `categoryId` exactly (`+page.server.ts:35` comment: "an unknown
type/category simply yields no filter / no matches"). It also avoids leaking
member existence across groups: a real member id from _another_ group produces
an empty list, indistinguishable from a made-up id, because `transaction_payers`
/ `transaction_shares` rows only ever belong to transactions in _this_ group and
the query is already `groupId`-scoped. **Do not add an existence check** — it
would cost a query and create the leak.

### D4 — `role` given without `member` is ignored

On every surface. It has no meaning alone. Web: drop it from generated URLs when
member is cleared. REST/MCP: accept and ignore rather than 422 — a bare `role`
is not a wrong _answer_, just a no-op, and rejecting it makes agents burn a turn.
State this in the schema doc comments so it is deliberate, not accidental.

### D5 — Inactive members stay selectable

`listMembers` returns soft-deactivated members (`deactivatedAt` set) and sorts
them last. They keep their historical transactions (`§6.3` — balances survive
deactivation), so they must remain filterable. Label them in the dropdown.

## Current state (verify these before editing)

- `src/lib/server/transactions.ts:695` — `TransactionListFilters` (`type`,
  `categoryId`, `after`, `from`, `to`).
- `src/lib/server/transactions.ts:773` — `listTransactions`, builds a
  `conditions[]` array, `innerJoin(categories)`, orders by the §16.4 total order.
- `src/lib/server/db/transactions-schema.ts:170` — `transactionPayers`, PK
  `(transaction_id, member_id)`, index on `transaction_id`.
- `src/lib/server/db/transactions-schema.ts:193` — `transactionShares`, same
  shape.
- `src/routes/groups/[id]/transactions/+page.server.ts:34` — filter parsing.
- `src/routes/groups/[id]/transactions/+page.svelte:45` — `filterUrl()`.
- `src/routes/api/v1/groups/[gid]/transactions/+server.ts:65` —
  `listQuerySchema`; `:87` — `presentParams` key list.
- `src/lib/server/mcp/tools/list-transactions.ts:45` — `listTransactionsArgs`.
- `static/api/v1/openapi.yaml:517` — the `CategoryIdFilter` parameter component.

> **Note for the executor**: `plans/README.md` has a "rejected" bullet saying
> `member_id` indexes on these tables wouldn't change any query plan. That was
> assessed against the _balances_ query, which only reads `member_id` in its
> SELECT list. This plan introduces the first query that **filters** on it. Step
> 2 supersedes that note for this feature; update the bullet when you finish.

## Steps

### Step 1 — Service: filters + `EXISTS` predicates

In `src/lib/server/transactions.ts`:

1. Extend `TransactionListFilters`:

   ```ts
   /**
    * Restrict to transactions this MEMBER is involved in. Involvement is ROW
    * PRESENCE, not a non-zero amount: a beneficiary whose resolved share is 0
    * was still named on the receipt (D1). An id that matches nothing — including
    * a real member of another group — simply yields no rows (D3).
    */
   memberId?: string;
   /**
    * Narrow `memberId` to one side of the transaction: 'paid' (a
    * `transaction_payers` row) or 'owes' (a `transaction_shares` row).
    * `undefined` = EITHER side — the "relates to me" default. Ignored when
    * `memberId` is absent (D4).
    */
   memberRole?: 'paid' | 'owes';
   ```

2. In `listTransactions`, after the `categoryId` condition, add:

   ```ts
   // "Relates to this member": correlated EXISTS over the payer / share rows.
   // A semi-join, NOT a join — joining `transaction_shares` would multiply rows
   // per beneficiary and silently break both the keyset cursor and the caller's
   // `limit`.
   if (filters.memberId) {
   	const paid = exists(
   		db
   			.select({ one: sql`1` })
   			.from(transactionPayers)
   			.where(
   				and(
   					eq(transactionPayers.transactionId, transactions.id),
   					eq(transactionPayers.memberId, filters.memberId)
   				)
   			)
   	);
   	const owes = exists(
   		db
   			.select({ one: sql`1` })
   			.from(transactionShares)
   			.where(
   				and(
   					eq(transactionShares.transactionId, transactions.id),
   					eq(transactionShares.memberId, filters.memberId)
   				)
   			)
   	);
   	conditions.push(
   		filters.memberRole === 'paid' ? paid : filters.memberRole === 'owes' ? owes : or(paid, owes)!
   	);
   }
   ```

   Import `exists`, `or`, `sql` from `drizzle-orm` and `transactionPayers` /
   `transactionShares` from the schema barrel (both are already imported in this
   file for the create path — check before adding).

3. Update the `listTransactions` doc comment to mention the member filter.

**Verify**: `pnpm check` → 0 errors.

### Step 2 — Indexes

In `src/lib/server/db/transactions-schema.ts`, add to each table's index list:

```ts
// Member-first lookup for the "relates to this member" list filter (plan 006).
// The composite PK (transaction_id, member_id) serves the correlated EXISTS
// when the planner drives from `transactions`; this index gives it the other
// direction — start from the member's (typically few) rows and semi-join back.
index('transaction_payers_member_id_idx').on(table.memberId, table.transactionId);
```

…and the matching `transaction_shares_member_id_idx`.

Then: `pnpm db:generate` → commit the generated `drizzle/0015_*.sql` **and** the
`drizzle/meta` updates. Do **not** hand-write the migration.

**Verify**: the generated SQL contains exactly two `CREATE INDEX` statements and
no other DDL. If it contains anything else, STOP — the schema has drifted.

### Step 3 — Service unit tests

In `src/lib/server/transactions.test.ts` (DB-mocked — it asserts _structure_, so
keep these assertions about the built query, in the style of the existing
`listTransactions` filter tests):

- `memberId` alone pushes a condition; `memberRole: 'paid'` / `'owes'` push a
  different one each (three distinct shapes).
- `memberRole` without `memberId` pushes nothing (D4).
- The member filter composes with `type` + `categoryId` + `from`/`to` + `after`
  (all conditions present together).
- The returned row shape is unchanged (no new fields, no duplicated rows).

**Verify**: `pnpm test:unit`.

### Step 4 — Real-DB integration test (this is the one that proves the SQL)

New file `tests/integration/transaction-member-filter.test.ts`, following
`tests/integration/settlement.test.ts` for setup/teardown and `helpers.ts` for
fixtures. Build a group with members A, B, C and:

| Txn | Payer | Beneficiaries     |
| --- | ----- | ----------------- |
| T1  | A     | A, B              |
| T2  | B     | B, C              |
| T3  | A     | B, C (A not owed) |
| T4  | C     | A (share of 0)    |

Assert:

- `memberId: A` (no role) → T1, T3, T4 — **and exactly one row each** (the
  anti-fan-out assertion; T1 has A as both payer and beneficiary).
- `memberId: A, memberRole: 'paid'` → T1, T3.
- `memberId: A, memberRole: 'owes'` → T1, T4 (T4 proves D1: a 0 share counts).
- `memberId: <id from another group>` → `[]`, no throw (D3).
- Member filter + `type` filter together narrows correctly.
- With `limit: 1`, the member filter still returns the newest matching row and
  the §16.4 cursor minted from it pages to the next _matching_ row.

**Verify**: `pnpm test:integration` (needs the local Postgres from
`docker-compose.yml`).

### Step 5 — Web: `+page.server.ts`

- Parse `member` (raw string, `?? undefined`) and `role` via a
  `parseRoleFilter(raw): 'paid' | 'owes' | undefined` helper mirroring
  `parseTypeFilter`.
- Pass `memberId` / `memberRole` into `listTransactions` — pass `memberRole`
  only when `memberId` is set (D4).
- Call `listMembers({ userId: user.id, groupId: params.id })` and return a
  trimmed list: `{ id, displayName, isSelf: m.userId === user.id, isInactive:
m.deactivatedAt !== null }`. Put it inside the existing `try` so a member-read
  failure degrades the same way the transaction read does (empty list, not a 500) — or a second `try` returning `[]`; either is fine, but the page must
  still render.
- Add `member` and `role` to the returned `filters` object (`?? null`).

### Step 6 — Web: `+page.svelte`

- `filterUrl()` gains `member` / `role`, same "drop empty params" handling.
  **Clearing member must also drop `role`.**
- Add a member `Select` next to the category one:
  - `All people` (value `''`) first,
  - then the self member labelled `Me (Name)` and pinned to the top,
  - then the rest in `listMembers` order,
  - inactive members suffixed ` (inactive)`.
  - Hide the whole control when `data.members.length < 2` — a solo group has
    nothing to filter.
- Role chips, rendered **only when a member is selected**, as plain links (the
  type chips are the template — no-JS friendly): `Both` (drops `role`) /
  `Paid by` (`role=paid`) / `For` (`role=owes`). Mark the active one with
  `variant="default"` like the type chips.
- Include `member` in the `hasActiveFilter(...)` call so a member filter that
  matches nothing renders the `filtered-empty` state, and make the "Clear
  filter" button clear member + role too.
- No new `$lib/empty-state` code is needed — `hasActiveFilter` is variadic.

**Verify**: `pnpm check`, `pnpm lint`, `pnpm format`. Then run the app and
confirm by hand: selecting a member narrows the list; the role chips appear;
back/forward navigation restores the filter (it is all in the URL); the page
works with JS disabled for the chip links.

### Step 7 — Web page tests

- `src/routes/groups/[id]/transactions/page.server.test.ts`: `member`/`role`
  reach `listTransactions`; a bare `role` is not forwarded; members are returned
  with `isSelf`/`isInactive`; an unknown `role` value is ignored.
- Add a mount test alongside the existing ones for the svelte side if this
  route has one (`mount.svelte.test.ts` — check; if the route has none, do not
  create the harness just for this).

### Step 8 — REST

In `src/routes/api/v1/groups/[gid]/transactions/+server.ts`:

- `listQuerySchema`: `memberId: z.string().min(1).optional()`,
  `role: z.enum(['paid', 'owes']).optional()`.
- Add `'memberId'` and `'role'` to the `presentParams` key list — **this is the
  easy step to forget; a param missing from that array is silently dropped.**
- Map into `TransactionListFilters`, honouring D4.
- Tests in `server.test.ts`: both params forwarded; bare `role` ignored;
  `role=bogus` → 422 `validation_error`; the response DTO is unchanged.

### Step 9 — OpenAPI

In `static/api/v1/openapi.yaml`, next to `CategoryIdFilter`, add:

```yaml
MemberIdFilter:
  name: memberId
  in: query
  required: false
  description: >-
    Only transactions this member is involved in — as a payer, a beneficiary, or
    both. An id that matches nothing returns an empty page, not an error.
  schema: { type: string, minLength: 1 }
RoleFilter:
  name: role
  in: query
  required: false
  description: >-
    Narrows `memberId` to one side: `paid` (the member paid) or `owes` (the
    member is a beneficiary). Omit for either side. Ignored without `memberId`.
  schema: { type: string, enum: ['paid', 'owes'] }
```

Reference both from the list operation's `parameters`, then run
`pnpm openapi:json` and commit the regenerated `openapi.json`.

**Verify**: `pnpm test:unit` — `src/lib/docs/openapi.test.ts` (yaml/json sync)
and `openapi.contract.test.ts` must both pass.

### Step 10 — MCP

In `src/lib/server/mcp/tools/list-transactions.ts`:

- Add `memberId` + `role` to `listTransactionsArgs` (same Zod shapes as REST —
  the schema is `strictObject`, so an undeclared arg is already rejected).
- Map into the filters, honouring D4.
- Extend the tool `description`: one clause naming the two args and stating that
  `memberId` comes from `list_members`. **Do not** weaken the existing
  "never sum this page — call `get_balances`" steering (ADR-0008); a member
  filter makes "just add up Alice's rows" _more_ tempting, so if anything the
  description should reinforce it.
- Tests in `tools.test.ts` (or the tool's own spec): args forwarded; bare `role`
  ignored; the ADR-0008 `_note` and `hasMore` behaviour unchanged.

### Step 11 — Docs & bookkeeping

- `PLAN.md §10`: update the route line to
  `Full transaction list (filter by type/category/member)`. This is a spec edit —
  keep it to that one line.
- `CONTEXT.md`: add the filter to whatever list of list-page capabilities it
  carries (check first; skip if it has none).
- `plans/README.md`: set this plan's status row to DONE and amend the
  "Missing `member_id` indexes" rejected bullet to note plan 006 supersedes it.
- No ADR. This introduces no new cross-cutting rule — it is an additive filter
  on an existing contract. (If Step 1 forces a change to the §16.4 cursor
  semantics, that _would_ need one — but it must not; see STOP conditions.)

## Verification (run all, in order, at the end)

```
pnpm check          # 0 errors
pnpm lint           # clean
pnpm format:check   # clean
pnpm test:unit      # all green, no pre-existing failures introduced
pnpm test:integration
pnpm test:e2e       # only if the e2e suite covers the transactions list
```

## STOP conditions

- **The member filter changes row counts per transaction.** If any test shows a
  transaction appearing twice, the `EXISTS` became a join. Stop and fix Step 1 —
  do not paper over it with `DISTINCT`, which would break the keyset order.
- **The §16.4 cursor stops round-tripping** under a member filter. The cursor
  encodes `(createdAt, occurredAt, id)` and is filter-independent by design; if
  the filter forces a cursor change, the design is wrong. Stop and report.
- **`pnpm db:generate` produces DDL beyond the two `CREATE INDEX` statements.**
- **The OpenAPI contract test fails on a response schema** (not a parameter).
  This change is request-side only; a response-side failure means something
  unrelated drifted.
- **Any existing test needs its assertions changed** to keep passing. The
  feature is purely additive — an existing expectation breaking means a
  behaviour change slipped in.
