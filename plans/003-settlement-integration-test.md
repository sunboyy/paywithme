# Plan 003: Add a settlement-lifecycle integration test (create → balances → settle → zero)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 32f4f15..HEAD -- src/lib/server/balances.ts src/lib/transactions/balances.ts src/lib/server/transactions.ts tests/integration/`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (adds a test file only; no runtime code changes)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `32f4f15`, 2026-06-20

## Why this matters

Settling up is the reason this app exists, yet the **core money lifecycle has no
real-DB integration test**. The pieces are unit-tested in isolation against mocked
data (`src/lib/transactions/balances.test.ts`, `src/lib/server/transactions.test.ts`),
and there is a UI happy-path e2e (`e2e/group-flow.spec.ts`), but nothing exercises
the real services against Postgres to assert the two invariants that matter:

1. After creating spending and then the suggested settling transfer, **every
   member's balance is exactly 0** (Σ paid_settlement == Σ owed across the group).
2. A **soft-deleted transaction does not affect balances** (PLAN §9).

A regression in `getGroupBalances`, `suggestSettlements`, the settlement
distribution in `resolveAndWriteTransaction`, or the `deleted_at IS NULL` filter
could ship undetected by the fast suite. An integration test on the real schema is
faster and more precise than the e2e (it asserts integer minor-unit balances
directly) and complements it.

## Current state

The integration suite already exists and gives you everything you need; model the
new file on `tests/integration/audit.test.ts` exactly.

- `tests/integration/helpers.ts` exports:
  - `describeIntegration(name, fn)` — a `describe` that auto-skips cleanly when the
    local Postgres is unreachable/unmigrated (so a DB-less `pnpm test:unit` run stays
    green; this suite runs under `pnpm test:integration`).
  - `createTestUser(label)` → `{ id, name }` — inserts a real better-auth user row.
  - `cleanupSuiteRows()` — deletes this suite's groups (and CASCADES their
    transactions + audit rows via `group_id onDelete: cascade`) and users. Call it
    in `afterEach`. The suite-prefix `it39-` scopes deletion to this suite's rows.
  - `db` — the Drizzle client.

- `tests/integration/audit.test.ts` is the structural template. Key helpers you
  will copy/adapt (lines cited):
  - `equalSpendingInput(memberIds, payerId, title?)` (lines 131–147) — a minimal
    valid equal-split spending input:
    ```ts
    function equalSpendingInput(memberIds, payerId, title = 'Dinner') {
    	return {
    		type: 'spending' as const,
    		title,
    		categoryId: SPENDING_CATEGORY, // categoriesFor('spending')[0].id
    		amountTotal: 9000,
    		currency: 'USD',
    		exchangeRate: '1',
    		amountTotalSettlement: 9000,
    		splitMode: 'equal' as const,
    		payers: [{ memberId: payerId, amountPaid: 9000 }],
    		beneficiaries: memberIds.map((memberId) => ({ memberId })),
    		items: [],
    		charges: []
    	};
    }
    ```
  - `freshGroup(name?)` (lines 149–157) — `createGroup({ userId, userName, name, settlementCurrency: 'USD' })`.
  - `creatorMemberId(groupId)` (lines 159–167) — looks up the creator's member id:
    ```ts
    async function creatorMemberId(groupId) {
    	const { members } = await import('$lib/server/db/groups-schema');
    	const [row] = await db
    		.select({ id: members.id })
    		.from(members)
    		.where(and(eq(members.groupId, groupId), eq(members.userId, userA.id)));
    	return row.id;
    }
    ```
  - `SPENDING_CATEGORY = categoriesFor('spending')[0].id` (line 52).

- Services under test (do not modify them):
  - `createTransaction({ userId, groupId, settlementCurrency, input })`
    (`src/lib/server/transactions.ts:159`) → returns the new txn id (string).
  - `softDeleteTransaction({ userId, groupId, txnId })` (same file).
  - `addMember({ userId, groupId, displayName })` (`src/lib/server/members.ts`) →
    returns the new member with `.id`.
  - `getGroupBalances({ userId, groupId })` (`src/lib/server/balances.ts:44`) →
    `MemberBalance[]`, one per ACTIVE member, `balance = Σ paid_settlement − Σ owed`,
    **guaranteed to sum to 0**, excludes soft-deleted transactions
    (`transactions.deleted_at IS NULL`, lines 76/88).
  - `suggestSettlements(balances)` (`src/lib/transactions/balances.ts:176`) →
    `SettlementSuggestion[]`, each `{ fromMemberId, toMemberId, amount }` (debtor
    pays creditor, `amount` positive minor units).

- **`MemberBalance`** = `{ memberId: string; balance: number }`
  (`src/lib/transactions/balances.ts:56`).

- A **transfer** input (how to settle) — `type: 'transfer'`, single payer (the
  debtor) and single beneficiary (the creditor), category `transfer-debt-settlement`
  (the only category whose `appliesTo === 'transfer'` that the settle UI uses).
  Transfers are NOT itemized. Shape (validated by the same `buildTransactionSchema`):
  ```ts
  function transferInput(fromMemberId, toMemberId, amount) {
  	return {
  		type: 'transfer' as const,
  		title: 'Settle up',
  		categoryId: 'transfer-debt-settlement',
  		amountTotal: amount,
  		currency: 'USD',
  		exchangeRate: '1',
  		amountTotalSettlement: amount,
  		splitMode: 'equal' as const,
  		payers: [{ memberId: fromMemberId, amountPaid: amount }],
  		beneficiaries: [{ memberId: toMemberId }], // single beneficiary owes the full amount
  		items: [],
  		charges: []
  	};
  }
  ```

## Commands you will need

| Purpose                          | Command                                       | Expected on success                                          |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Typecheck                        | `pnpm check`                                  | exit 0, 0 errors                                             |
| Run integration suite            | `pnpm test:integration`                       | the new suite passes (or skips cleanly if no DB — see below) |
| Run only the new file            | `pnpm test:integration -- settlement`         | the new suite passes/skips                                   |
| Start local Postgres (if needed) | `docker compose up -d` then `pnpm db:migrate` | container up; migrations applied                             |
| Lint                             | `pnpm lint`                                   | exit 0                                                       |

**About the DB**: integration tests need a local Postgres. The suite auto-skips
with a clear message when none is reachable (via `describeIntegration`). To get a
real PASS you must have the DB up and migrated (`docker compose up -d` +
`pnpm db:migrate`; see `docs/local-dev.md`). If you cannot start a DB, a clean
SKIP is acceptable proof the suite is wired correctly — but say so explicitly in
your report and do not claim the assertions ran.

## Scope

**In scope** (the only file you create):

- `tests/integration/settlement.test.ts` (create)

**Out of scope** (do NOT modify):

- `src/lib/server/balances.ts`, `src/lib/transactions/balances.ts`,
  `src/lib/server/transactions.ts` — services under test; if a test fails, the test
  or your inputs are wrong before the service is (these are heavily unit-tested).
  Do NOT "fix" a service to make a test pass — that's a STOP condition.
- `tests/integration/helpers.ts`, `setup.ts` — reuse, don't change.
- Any other existing integration test file.

## Git workflow

- Branch: `advisor/003-settlement-integration-test`.
- One commit, Conventional Commits style (see `git log`, e.g.
  `test(audit): real-DB integration tests for the audit trail`):
  `test(settlement): real-DB integration test for the settle lifecycle`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Scaffold the file

Create `tests/integration/settlement.test.ts`. Copy the imports, the
`describeIntegration(...)` wrapper, the `beforeEach`/`afterEach`
(`userA`/`userB` + `cleanupSuiteRows()`), and the helpers
(`SPENDING_CATEGORY`, `equalSpendingInput`, `freshGroup`, `creatorMemberId`)
from `tests/integration/audit.test.ts:28–167`. Add the `transferInput` helper
from "Current state". Import the services: `createGroup` from `$lib/server/groups`,
`addMember` from `$lib/server/members`, `createTransaction` +
`softDeleteTransaction` from `$lib/server/transactions`, `getGroupBalances` from
`$lib/server/balances`, `suggestSettlements` from `$lib/transactions/balances`,
`categoriesFor` from `$lib/categories`, and the helpers from `./helpers`.

Add a top-of-file comment explaining the suite's purpose (mirror the doc-comment
style of `audit.test.ts:1–26`).

**Verify**: `pnpm check` → exit 0 (file typechecks even before tests are filled in).

### Step 2: Test — full settle lifecycle nets every balance to zero

Add an `it(...)` that:

1. Creates a group owned by `userA` (`freshGroup('Settle')`), settlement currency USD.
2. Adds a second member: `const bob = await addMember({ userId: userA.id, groupId, displayName: 'Bob' })`.
   Get `const aliceId = await creatorMemberId(groupId)`.
3. Creates a `9000`-minor-unit equal-split spending where Alice pays for both:
   `createTransaction({ userId: userA.id, groupId, settlementCurrency: 'USD', input: equalSpendingInput([aliceId, bob.id], aliceId) })`.
4. Asserts balances: `const balances = await getGroupBalances({ userId: userA.id, groupId })`.
   - `balances` has length 2.
   - The sum of all `balance` values is `0`.
   - Alice's balance is `+4500` (paid 9000, owes 4500) and Bob's is `-4500`
     (paid 0, owes 4500). Look each up by `memberId`.
5. Computes suggestions: `const suggestions = suggestSettlements(balances)`.
   - Exactly one suggestion: `{ fromMemberId: bob.id, toMemberId: aliceId, amount: 4500 }`.
6. Records that suggested transfer:
   `createTransaction({ userId: userA.id, groupId, settlementCurrency: 'USD', input: transferInput(bob.id, aliceId, 4500) })`.
7. Re-reads balances and asserts **every** member's `balance === 0` and
   `suggestSettlements(newBalances)` is empty (`[]`).

**Verify**: `pnpm test:integration -- settlement` → this test passes (or the whole
suite skips cleanly if no DB is available).

### Step 3: Test — soft-deleted transactions are excluded from balances

Add a second `it(...)` that:

1. Creates a fresh group + second member (as above).
2. Creates an equal-split spending (e.g. `9000`, Alice pays) → capture `txnId`.
3. Asserts balances are non-zero (Alice `+4500`, Bob `-4500`).
4. `await softDeleteTransaction({ userId: userA.id, groupId, txnId })`.
5. Re-reads `getGroupBalances` and asserts **every** member's `balance === 0`
   (the deleted transaction no longer contributes), and `suggestSettlements` is `[]`.

**Verify**: `pnpm test:integration -- settlement` → both tests pass (or skip cleanly).

### Step 4: Full checks

**Verify**:

- `pnpm check` → exit 0.
- `pnpm lint` → exit 0.
- `pnpm test:integration` → the settlement suite passes (with a DB) or skips
  cleanly (without). The other integration suites must remain green/skip.
- `pnpm test:unit` → still all pass (you added nothing under `src/**`, so unit count
  is unchanged; this confirms you didn't accidentally place a test where the fast
  suite would pick it up).

## Test plan

- New file `tests/integration/settlement.test.ts`, modeled on
  `tests/integration/audit.test.ts`.
- Cases:
  1. Create spend → balances correct (Alice +4500 / Bob −4500, Σ=0) → exactly one
     suggested transfer (Bob→Alice 4500) → record it → all balances 0, no suggestions.
  2. Create spend → balances non-zero → soft-delete the txn → all balances 0,
     no suggestions (PLAN §9 exclusion).
- Verification: `pnpm test:integration -- settlement` → both pass (DB up) or the
  suite skips cleanly (DB down).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `tests/integration/settlement.test.ts` exists and contains ≥ 2 `it(` blocks
- [ ] `pnpm check` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test:integration` runs the new suite: it PASSES with a local DB, or
      SKIPS cleanly with the `[skipped: ...]` label when no DB is present (report which)
- [ ] `pnpm test:unit` still all pass (unchanged count; new file is not picked up by the fast suite)
- [ ] `git status --porcelain` shows only `tests/integration/settlement.test.ts` added
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back (do not improvise) if:

- A balance assertion fails against the real DB (e.g. balances don't sum to 0, or a
  soft-deleted txn still affects balances). That would be a **real product bug** —
  report the exact numbers; do NOT modify the service code to make the test pass.
- The `transferInput` shape is rejected by validation (`TransactionValidationError`).
  Inspect `buildTransactionSchema` in `src/lib/schemas/transaction.ts` for the
  transfer rules and adjust the helper (likely `splitMode`/beneficiary shape), then
  retry once. If it still fails, report the validation issues and stop.
- The helper signatures in `audit.test.ts` (e.g. `createTransaction`,
  `getGroupBalances`) differ from the "Current state" excerpts (drift).

## Maintenance notes

- This suite is in the OPT-IN `integration` project (`pnpm test:integration`), NOT
  the CI fast gate. If integration tests are later added to CI, ensure a Postgres
  service is provisioned there.
- If the settlement currency model or the transfer category id changes, update the
  helpers here.
- A reviewer should confirm the test asserts exact integer minor-unit balances
  (not floats) and that no `src/**` runtime file was touched.
- Cleanup relies on `groups → transactions` cascade; if that cascade is ever
  removed, this suite would leak rows — add scoped deletes then.
