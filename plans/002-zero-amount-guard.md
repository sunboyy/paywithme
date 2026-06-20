# Plan 002: Reject zero-amount transactions in the shared schema

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 32f4f15..HEAD -- src/lib/schemas/transaction.ts src/lib/schemas/transaction.test.ts`
> If either file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (correctness)
- **Planned at**: commit `32f4f15`, 2026-06-20

## Why this matters

The shared transaction schema accepts a transaction whose total is **zero**.
`amountTotal` uses `minorUnitsField`, which is `.nonnegative()` (so it permits
`0`), and there is no cross-field rule requiring the total to be greater than
zero for non-itemized splits. As a result a user can create a `$0.00`
transaction: it passes validation, writes a real `transactions` row plus an audit
entry, and clutters the ledger and activity feed with a meaningless record. There
is no math corruption (every share resolves to 0), but a money app should not let
a zero-value transaction be recorded. A single Zod refine closes this with no risk
to the resolution or settlement code.

## Current state

- `src/lib/schemas/transaction.ts` — the shared create/edit input schema, built
  by `buildTransactionSchema(...)` and used **identically on server and client**
  (the server re-validates in `src/lib/server/transactions.ts:191`). Relevant
  excerpts:

  The numeric field (around line 84) permits zero:

  ```ts
  const minorUnitsField = z
  	.number({ message: 'Amount is required' })
  	.int({ message: 'Amount must be in whole minor units' })
  	.nonnegative({ message: 'Amount must be zero or more' })
  	.safe({ message: 'Amount is out of range' });
  ```

  Inside `buildTransactionSchema` the object uses it for the total (around line 509):

  ```ts
  amountTotal: minorUnitsField,
  ```

  The schema then chains many `.refine(...)` cross-field rules (lines ~522–660+).
  For **itemized** transactions there is already a `>= 0` rule (line ~593:
  "itemized: amount_total >= 0 after charges"), but **nothing requires the total to
  be strictly positive** for `equal` / `amount` / `share` splits. For example, an
  equal split of `amountTotal: 0` across members resolves to 0 each and passes
  `splitInputsValid`.

- The schema is a long chain of `.refine()` calls on the object returned at
  `buildTransactionSchema` (line ~498). Adding one more `.refine()` in that chain
  is the established pattern — follow the surrounding refines exactly (each has a
  `message` and a `path`).

- Test pattern: `src/lib/schemas/transaction.test.ts` builds a schema with
  `buildTransactionSchema({ settlementCurrency: 'THB' })` and uses a `baseSpending`
  helper plus `safeParse`. Match this exactly. Excerpt (lines 19–43):

  ```ts
  const thbSchema = buildTransactionSchema({ settlementCurrency: 'THB' });

  function baseSpending(overrides: Record<string, unknown> = {}) {
  	return {
  		type: 'spending',
  		title: 'Dinner',
  		categoryId: 'spending-food-drink',
  		amountTotal: 9000, // ฿90.00
  		currency: 'THB',
  		exchangeRate: '1',
  		amountTotalSettlement: 9000,
  		splitMode: 'equal',
  		payers: [{ memberId: 'm1', amountPaid: 9000 }],
  		beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }],
  		items: [],
  		charges: [],
  		...overrides
  	};
  }

  it('accepts a valid equal-split spending', () => {
  	expect(thbSchema.safeParse(baseSpending()).success).toBe(true);
  });
  ```

  Tests that assert a rejection inspect `parsed.success === false` and the issue
  `path`/`message` (see other rejection tests in this file for the exact idiom —
  search for `.success).toBe(false)`).

## Commands you will need

| Purpose                   | Command                              | Expected on success             |
| ------------------------- | ------------------------------------ | ------------------------------- |
| Typecheck                 | `pnpm check`                         | exit 0, 0 errors                |
| Run the schema tests only | `pnpm test:unit -- transaction.test` | all pass incl. new tests        |
| Full fast unit suite      | `pnpm test:unit`                     | all pass (was 724 at plan time) |
| Lint                      | `pnpm lint`                          | exit 0                          |

## Scope

**In scope** (the only files you may modify):

- `src/lib/schemas/transaction.ts` — add one `.refine()`.
- `src/lib/schemas/transaction.test.ts` — add tests.

**Out of scope** (do NOT touch, even though they look related):

- `src/lib/server/transactions.ts` — it already re-validates via this schema; the
  new refine flows through automatically. Do not add a duplicate check there.
- `src/lib/transactions/resolve.ts` / `balances.ts` — resolution math is correct;
  no change needed.
- `minorUnitsField` itself — do NOT make it `.positive()`. It is reused for
  per-member amounts, share weights, and charge amounts where `0` is legitimate
  (e.g. a member with share weight 0, a payer line, an item). Changing it would
  break valid inputs. Add the rule ONLY at the `amountTotal` cross-field level.

## Git workflow

- Branch: `advisor/002-zero-amount-guard`.
- One commit, Conventional Commits style (see `git log`):
  `fix(transactions): reject zero-amount transactions in the shared schema`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the refine in `buildTransactionSchema`

In `src/lib/schemas/transaction.ts`, add one `.refine()` to the chain inside
`buildTransactionSchema` (alongside the existing refines, e.g. right after the
"Σ amount_paid == amount_total" refine near line 537). The rule:

- `amountTotal` must be strictly greater than 0.
- Message: `The transaction total must be greater than zero`.
- `path: ['amountTotal']`.

Target shape (match the surrounding refines' formatting and comment style):

```ts
// ── total must be > 0: a zero-value transaction is meaningless (clutters the
//    ledger). minorUnitsField allows 0 for per-member lines, so enforce > 0 here. ─
.refine((tx) => tx.amountTotal > 0, {
	message: 'The transaction total must be greater than zero',
	path: ['amountTotal']
})
```

This covers itemized too (itemized's total equals items subtotal ± charges; a
zero total is now rejected uniformly). The existing itemized `>= 0` refine stays
as-is — it guards the discount-exceeds-base case and is still meaningful for
totals `> 0`.

**Verify**: `pnpm check` → exit 0.

### Step 2: Add tests

In `src/lib/schemas/transaction.test.ts`, add a `describe` block (or extend an
existing rejection block) with these cases, using the `baseSpending` helper and
`thbSchema`:

1. **Rejects a zero-total equal split**:
   ```ts
   const parsed = thbSchema.safeParse(
   	baseSpending({
   		amountTotal: 0,
   		amountTotalSettlement: 0,
   		payers: [{ memberId: 'm1', amountPaid: 0 }]
   	})
   );
   expect(parsed.success).toBe(false);
   ```
   Also assert the failure includes an issue with `path` `['amountTotal']` and the
   new message (mirror how other rejection tests in this file read `parsed.error.issues`).
2. **Still accepts a normal positive total** — a sanity case asserting
   `thbSchema.safeParse(baseSpending()).success === true` (guards against the refine
   being too strict). One such positive case already exists; add an explicit one
   tied to this rule if it reads clearly, otherwise rely on the existing
   "accepts a valid equal-split spending" test.
3. **Rejects a zero-total itemized transaction** (optional but preferred): build an
   itemized input whose single item has `amount: 0` so the computed total is 0, and
   assert `parsed.success === false`. If constructing a valid-but-zero itemized
   input proves fiddly (other itemized refines fire first), SKIP this third case and
   note it in your report rather than forcing it — cases 1 and 2 are the required ones.

**Verify**: `pnpm test:unit -- transaction.test` → all pass, including the new cases.

### Step 3: Full suite + lint

**Verify**:

- `pnpm test:unit` → all pass (no regressions; was 724 at plan time, expect that
  plus your new tests).
- `pnpm lint` → exit 0.

## Test plan

- New tests live in `src/lib/schemas/transaction.test.ts`, modeled on the existing
  `buildTransactionSchema` rejection tests in that same file.
- Cases: (a) zero-total equal split rejected with `path: ['amountTotal']`,
  (b) positive total still accepted, (c) optional zero-total itemized rejected.
- Verification: `pnpm test:unit -- transaction.test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm check` exits 0
- [ ] `pnpm test:unit` exits 0; new zero-amount tests in
      `src/lib/schemas/transaction.test.ts` exist and pass
- [ ] `grep -n "must be greater than zero" src/lib/schemas/transaction.ts` finds the refine
- [ ] `pnpm lint` exits 0
- [ ] `git status --porcelain` shows only the two in-scope files modified
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `buildTransactionSchema` no longer exists or its refine-chain structure differs
  materially from the "Current state" excerpt (drift).
- Adding the `amountTotal > 0` refine breaks an EXISTING test — that would mean some
  current valid flow relies on a zero total; report which test and stop rather than
  weakening the rule.
- You find an existing `amountTotal > 0` (or equivalent positive) refine already
  present — then this plan is already done; report that and stop.

## Maintenance notes

- The rule lives in the SHARED schema, so client (live form validation) and server
  (`createTransaction` / `updateTransaction` re-validation) both enforce it — no
  second check needed elsewhere.
- If a future feature legitimately needs a zero-total transaction (none is planned
  in `PLAN.md`), this refine is the single place to relax.
- A reviewer should confirm the refine is on `amountTotal` only and that
  `minorUnitsField` was NOT changed to `.positive()`.
