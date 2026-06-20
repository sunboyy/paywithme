# Plan 004: Mark inactive members in the settle-up balances list

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 32f4f15..HEAD -- src/routes/groups/[id]/settle/`
> If either file under that path changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction (UX)
- **Planned at**: commit `32f4f15`, 2026-06-20

## Why this matters

Per `PLAN.md §6.3`, soft-deactivating a member does **not** clear their
outstanding balance — "the suggested-settlement view still shows what they owe /
are owed until settled." The settle page correctly keeps these balances in the
list (a deactivated member with ledger activity still appears, with the right
amount). **But the page gives no visual signal that such a member is inactive.**
An active member reading the balances can't tell that "Bob owes ฿120" refers to
someone who has left the group — which is exactly the person you most need to know
to chase before closing the books.

This is a small, contained UX fix: add an "Inactive" marker to balance rows whose
member is soft-deactivated. It is purely presentational — no money math, no schema,
no access changes.

> **Scope correction (read this — it changes the original idea).** An earlier
> suggestion framed this as "let a member who has left see their own outstanding
> balance." That is **not reachable** in the current model: `userHasGroupAccess`
> (`src/lib/server/groups.ts`) requires `isNull(members.deactivatedAt)`, so a
> soft-deactivated user is denied access (404) to every group page and can't view
> anything. Do NOT attempt to grant deactivated users access — that's a deliberate
> access-control decision and out of scope. The reachable, valuable change is the
> one in this plan: label inactive members in the list that ACTIVE members see.

## Current state

Two files, both already read in full for this plan.

- `src/routes/groups/[id]/settle/+page.server.ts` — the `load`. It already loads
  the full member roster (including deactivated members) via `listMembers`, and uses
  it only for the display-name map. The balance rows it returns do NOT carry an
  active/inactive flag. Relevant excerpts:

  ```ts
  const balances = await getGroupBalances({ userId: user.id, groupId: params.id });
  const members = await listMembers({ userId: user.id, groupId: params.id });

  // memberId → display name. Members can be deactivated yet still carry a balance...
  const nameById = new Map(members.map((m) => [m.id, m.displayName]));
  const displayName = (memberId: string): string => nameById.get(memberId) ?? memberId;

  const ordered = orderByWhoShouldPay(balances);
  const balanceRows = ordered.map((b: MemberBalance) => ({
  	memberId: b.memberId,
  	displayName: displayName(b.memberId),
  	balance: b.balance,
  	balanceFormatted: formatAmount(b.balance, settlementCurrency),
  	isDebtor: b.balance < 0,
  	isCreditor: b.balance > 0
  }));
  ```

  - `listMembers(...)` returns `MemberListItem[]`. Each item has
    `deactivatedAt: string | null` (non-null ⇒ soft-deactivated) — see
    `src/lib/server/members.ts:72-80`. Use this to derive an active flag.
  - `getGroupBalances` returns one entry per ACTIVE member PLUS any member id that
    has ledger activity (so a deactivated member who still owes/ is owed DOES appear
    in `balanceRows`). This is why the marker is needed.

- `src/routes/groups/[id]/settle/+page.svelte` — renders `data.balances`. The
  balance row already renders status badges; you will add one more branch.
  Relevant excerpt (the `{#each data.balances ...}` block):

  ```svelte
  <span class="flex items-center gap-2">
  	<span class="font-medium">{row.displayName}</span>
  	{#if row.isDebtor}
  		<Badge variant="destructive">owes</Badge>
  	{:else if row.isCreditor}
  		<Badge variant="secondary">is owed</Badge>
  	{:else}
  		<Badge variant="outline">settled</Badge>
  	{/if}
  </span>
  ```

  `Badge` is already imported (`import { Badge } from '$lib/components/ui/badge';`).
  It is a shadcn-svelte component — **use it, do not edit the component file.**

## Commands you will need

| Purpose         | Command             | Expected on success |
| --------------- | ------------------- | ------------------- |
| Typecheck       | `pnpm check`        | exit 0, 0 errors    |
| Lint            | `pnpm lint`         | exit 0              |
| Format check    | `pnpm format:check` | exit 0              |
| Fast unit suite | `pnpm test:unit`    | all pass            |

## Scope

**In scope** (the only files you may modify):

- `src/routes/groups/[id]/settle/+page.server.ts` — add an `isActive` flag to each
  balance row.
- `src/routes/groups/[id]/settle/+page.svelte` — render an "Inactive" marker.

**Out of scope** (do NOT touch):

- `src/lib/server/groups.ts` / `access.ts` — do NOT change the access rule to admit
  deactivated members (see the scope correction above).
- `src/lib/server/balances.ts`, `src/lib/transactions/balances.ts` — balance math is
  correct and unchanged.
- `src/lib/components/ui/**` — shadcn-generated; never hand-edit.
- The suggested-settlements section of the page — leave its rendering as-is (the
  marker goes only on the "Balances" list).

## Git workflow

- Branch: `advisor/004-inactive-member-marker`.
- One commit, Conventional Commits style:
  `feat(settlement): mark inactive members in the balances list`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add an `isActive` flag to balance rows in the load

In `src/routes/groups/[id]/settle/+page.server.ts`, build an active-status lookup
from the already-loaded `members` and add `isActive` to each row in `balanceRows`:

```ts
// memberId → is the member still active (not soft-deactivated, §6.3)? A
// deactivated member can still carry a balance, so the settle list marks them.
const isActiveById = new Map(members.map((m) => [m.id, m.deactivatedAt == null]));
```

Then in the `balanceRows` map, add:

```ts
isActive: isActiveById.get(b.memberId) ?? true,
```

(Default `true` defensively — a balance row with no matching roster entry is treated
as active rather than mislabeling it.)

**Verify**: `pnpm check` → exit 0.

### Step 2: Render the "Inactive" marker

In `src/routes/groups/[id]/settle/+page.svelte`, inside the `{#each data.balances}`
name span, add an `Inactive` badge when the row is not active — placed after the
existing owes/is owed/settled badge:

```svelte
<span class="flex items-center gap-2">
	<span class="font-medium">{row.displayName}</span>
	{#if row.isDebtor}
		<Badge variant="destructive">owes</Badge>
	{:else if row.isCreditor}
		<Badge variant="secondary">is owed</Badge>
	{:else}
		<Badge variant="outline">settled</Badge>
	{/if}
	{#if !row.isActive}
		<Badge variant="outline" class="text-muted-foreground">Inactive</Badge>
	{/if}
</span>
```

Keep the existing amount span untouched.

**Verify**: `pnpm check` → exit 0; `pnpm format:check` → exit 0 (run `pnpm format`
if it complains about these two files, then re-check).

### Step 3: Full checks

**Verify**:

- `pnpm lint` → exit 0.
- `pnpm test:unit` → all pass (no test depends on the exact balance-row shape; this
  is additive). If a settle-page test exists and asserts the row shape, update it to
  expect the new `isActive` field.

## Test plan

- This is a small presentational change. There is no dedicated unit test for the
  settle `load` at plan time; if you find one
  (`src/routes/groups/[id]/settle/*.test.ts`), extend it to assert `isActive` is
  present and `false` for a deactivated member, `true` for an active one — model it
  on the existing members page test
  (`src/routes/groups/[id]/members/page.server.test.ts`).
- If no such test exists, do NOT create a new harness for it — the typecheck + lint +
  existing suite are sufficient for this low-risk change. Note in your report that
  the change is covered only by typecheck/manual inspection.
- Manual check (optional, if a DB + dev server are available): deactivate a member
  who has a balance, then load `/groups/[id]/settle` as an active member and confirm
  the "Inactive" badge shows next to that member's row.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "isActive" src/routes/groups/[id]/settle/+page.server.ts` finds the new field
- [ ] `grep -n "Inactive" src/routes/groups/[id]/settle/+page.svelte` finds the new badge
- [ ] `pnpm check` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm test:unit` all pass
- [ ] `git status --porcelain` shows only the two in-scope files modified
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `listMembers` no longer returns `deactivatedAt` on its items, or `balanceRows` is
  structured differently from the "Current state" excerpt (drift).
- You find yourself needing to change `userHasGroupAccess`/`requireGroupAccess` to
  make the marker visible — that means the requirement was misunderstood; stop and
  report (the marker is for the list ACTIVE members see, not for granting access to
  deactivated users).
- An existing settle-page test fails and the fix is not a simple "add the new field
  to the expected shape."

## Maintenance notes

- This only marks inactivity in the "Balances" list. If product later wants the
  suggested-settlements rows to also indicate an inactive counterparty, that's a
  follow-up (the same `isActiveById` map can feed the `suggestions` mapping).
- If self-service "leave group" is ever added (which WOULD require revisiting the
  access rule), reconsider whether a departed member should see their own final
  balance — explicitly deferred here.
- A reviewer should confirm no access-control code changed and that the `Badge`
  component file was not edited.
