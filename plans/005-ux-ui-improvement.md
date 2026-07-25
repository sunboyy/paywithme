# Plan 005: UX/UI improvement pass

> **Executor instructions**: Items below are independently shippable and ordered
> by leverage. Ship them as separate commits (one item = one commit) so each can
> be reviewed and reverted alone. Run `pnpm check && pnpm test:unit` after each.
> If anything in "STOP conditions" occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat c3aac7f..HEAD -- src/routes src/lib/components src/app.css`
> If these paths changed since this plan was written, re-verify the "Current
> state" excerpt of the affected item before proceeding.

## Status

- **Priority**: P1
- **Effort**: L (split across 4 stages; each stage is S–M)
- **Risk**: LOW–MED (presentation only; no money-math or schema changes)
- **Depends on**: none
- **Category**: UX/UI

## How this review was done

The app was built and run for real (`docker compose up -d` → `pnpm db:migrate`
→ Playwright against `pnpm preview`), seeded with a realistic group (4 members,
5 spending transactions, JPY), and every surface screenshotted at 390px and
1440px. Findings below are from the rendered UI, not from reading code alone.

**The strongest screen today is `/groups/[id]/transactions/[txid]`** — big
amount, clear PAID BY / OWED sections, quiet metadata. It is the model the rest
of the app should converge on. Nothing in this plan changes that page's
structure.

---

# Stage 1 — Fix what is visibly broken (P0, effort S)

## 1.1 Card section-header links wrap to their own line

**Current state.** Every "Balances / Settle up →", "Recent transactions / See
all →", "Recent activity / See all →" header renders the link on a _second_
line, left-aligned under the title, instead of right-aligned on the same row.

**Root cause.** `src/lib/components/ui/card/card-header.svelte` (shadcn CLI
output) is `display: grid` with
`has-data-[slot=card-action]:grid-cols-[1fr_auto]`. Four call sites pass
`class="flex-row items-center justify-between"`. `cn()` (tailwind-merge) treats
`display` and `flex-direction` as different groups, so it keeps **both**:
`grid` wins and `flex-row justify-between` is inert.

**Fix.** Drop the `flex-row …` class overrides and wrap the trailing link in
`<Card.Action>` — the slot shadcn provides for exactly this, which is what
triggers the `grid-cols-[1fr_auto]` variant.

**Affected files** (4 occurrences):

- `src/routes/groups/+page.svelte` — the currency badge in the group card
- `src/routes/groups/[id]/+page.svelte` — all three section headers

**Verify.** Screenshot `/groups/[id]` at 390px: title and link share one row.

## 1.2 Money reads "JPY ¥3,200" on every row

**Current state.** `symbolPrefix()` (`src/lib/money/money.ts:255`) returns
`` `${code} ${symbol}` `` whenever the symbol does not start with a letter. So
inside a JPY group _every_ amount renders `JPY ¥3,200`, and negatives render
`JPY ¥-21,560` (minus after the symbol).

The disambiguation rule is correct **globally** — but inside a group the
settlement currency is fixed and already stated in the page header, so the code
is pure noise on every row, and it is a direct cause of item 1.3 (it widens the
amount column enough to truncate titles).

**Fix.** Do **not** change `symbolPrefix`'s default — it is right for
cross-group surfaces. Add an opt-out instead:

- Extend `FormatAmountOptions` with `code?: boolean` (default `true`).
- When `code: false`, return `` `${symbol}${numeric}` ``.
- Move the sign outside the symbol: `-¥21,560`, not `¥-21,560`.
- Pass `{ code: false }` from every in-group surface: group overview,
  transactions list, transaction detail, settle page, `TransactionForm`
  breakdown.
- Keep the code on the groups list (multiple currencies coexist there) and on
  the foreign-currency secondary line (where two currencies appear together).

**STOP condition.** `src/lib/money/money.test.ts` asserts the current
`symbolPrefix` behaviour. Those assertions must keep passing unchanged — the new
behaviour is additive. If you find yourself editing an existing assertion, stop.

## 1.3 Transaction titles truncate at ~12 characters on phone

**Current state.** At 390px the list shows `Museum tic…`, `Konbini sn…`,
`Airbnb Shi…`, `Shinkans…`, `Dinner at Ic…` — with whitespace to spare. Three
things eat the row: a `spending` badge on every row, the `JPY ` prefix (1.2),
and the category name duplicated in the subtitle.

**Fix** (`src/routes/groups/[id]/transactions/+page.svelte`,
`src/routes/groups/[id]/+page.svelte`):

- Drop the `spending` badge. It is redundant three times over: the category icon
  already encodes it, the filter chips above state it, and ~all rows are
  spending. **Keep** a badge for `transfer` only — that is the exceptional case
  worth marking.
- Apply 1.2 (`¥3,200`, not `JPY ¥3,200`).
- Let the title take the freed width.

**Verify.** At 390px, `Shinkansen tickets` and `Dinner at Ichiran` render in
full.

## 1.4 The same date repeats on every row

**Current state.** Five rows, each stamped `Jul 25, 2026`. The date column
carries no information yet costs a line of subtitle on every row.

**Fix.** Group the transactions list by day with a small sticky date subheader
(`Today` / `Yesterday` / `Jul 25`), and drop the per-row date. Grouping happens
in the component from the already-loaded `createdAt`; no server change.

On the overview's "Recent transactions" (max 5) keep it simpler: show a relative
date (`today`, `2d ago`) via the existing `relativeTime()` in
`src/lib/activity-labels.ts`.

---

# Stage 2 — Answer the user's actual question (P1, effort M)

The app currently never tells you _your own_ position. It renders a neutral
table of all four members and leaves you to find your row. Every screen in this
category (Splitwise, Tricount, Settle Up) leads with the viewer's number,
because that is the only thing most sessions are opened to check.

## 2.1 Lead the group overview with the viewer's net position

**Current state.** `/groups/[id]` opens with a "Balances" card listing all
members in identical weight. `Alex Chen · is owed · JPY ¥64,680` is the fourth
row, visually indistinguishable from the rest.

**Fix.** Add a hero summary above the Balances card:

```
You are owed
¥64,680                          [ Settle up ]
across 3 people
```

…and the mirror for a net debtor ("You owe ¥21,560"), and a settled state
("You're all square"). The viewer's member id is already resolvable server-side
in `src/routes/groups/[id]/+page.server.ts` (the acting user's member row is
what `members.userId` maps to). Keep the full per-member list below it, but mark
the viewer's row with a `You` badge — the members page already has this badge,
so reuse it.

## 2.2 Groups list shows currency instead of balance

**Current state.** A group card shows the name and a `$ USD` badge. It answers
a question nobody has and omits the one everyone has. The code comment says net
balances were "intentionally NOT shown — Phase 5 (task 5.1)"; Phase 5 shipped,
so the deferral is stale.

**Fix.** Put the viewer's net balance on each card
(`you are owed ¥64,680` / `you owe $12.50` / `settled up`), colour-coded per
2.4, with the currency badge demoted or dropped (the amount already carries the
symbol). Extend `src/routes/groups/+page.server.ts` to compute per-group net for
the acting user — reuse `src/lib/server/balances.ts` rather than writing a
second balance path.

**STOP condition.** If reusing the balances helper means an N+1 across groups,
batch it in one query; do not ship a per-group loop.

## 2.3 The landing page is a dead end

**Current state.** An anonymous visitor gets a bordered card that repeats the
app name already in the header, one sentence of copy, and **no call to action**.
The only way in is the small grey "Sign in" text in the top corner. The code
comment marks it a "static landing placeholder … deferred to Phase 2" — that
deferral was never picked back up.

**Fix.** A real (still small) landing: headline, one-line value proposition,
primary `Create an account` button, secondary `Sign in` link, and three short
capability lines (split any way · multi-currency · no account needed for
participants). No marketing site — just an entry point that converts.

## 2.4 Give "owed" and "owes" distinct, non-red-only encoding

**Current state.** Debtors are `text-destructive` red; creditors are default
foreground black. So "someone owes money" is styled as an _error_, and being
owed money — the good case — has no positive encoding at all. Red-only also
fails for red-green colour blindness when paired with the `owes`/`is owed`
badges.

**Fix.** Introduce semantic money tokens in `src/app.css` (see 4.1) —
`--money-positive` (you're owed) and `--money-negative` (you owe) — distinct
from `--destructive`, which should mean _destructive action_ (Delete) only.
Always pair colour with the existing text badge so colour is never the sole
channel.

---

# Stage 3 — The forms (P1, effort M–L)

## 3.1 Members page renders three controls per member, permanently

**Current state.** The roster renders, for _every_ member, an always-open edit
form: a filled text input, a full-width `Rename` button, and a `Remove <name>`
button. Four members = 12 controls and roughly 600px of vertical space, for a
screen whose job is "show me who's in this group".

**Fix** (`src/routes/groups/[id]/members/+page.svelte`):

- Default to a read-only roster row: avatar/initial, display name, `You` badge,
  and a single icon-button opening a menu (`Rename`, `Remove`).
- `Rename` swaps that row into the existing inline form; everything else stays
  read-only.
- Keep both forms as real `<form method="POST">` so the no-JS path still works —
  render the menu as a `<details>`-based disclosure rather than a JS-only
  popover, or keep the plain forms in a `<noscript>`-reachable expanded state.

**STOP condition.** `e2e/group-flow.spec.ts` drives `Add a member` /
`Add member` by label. Do not rename those. Rename/remove controls are not
currently asserted in e2e, but check `src/routes/groups/[id]/members/page.server.test.ts`
before changing any `name=` attributes.

## 3.2 Add-transaction is a flat stack with no hierarchy

**Current state.** Eight sections of identical visual weight: Type, Title, Date,
Category, Currency, Amount, Paid by, Split, Split between. The **Amount** — the
single most consequential input — looks exactly like Title, and its `¥` sits
_outside_ the input box as loose grey text, reading as a rendering glitch.

**Fix** (`src/lib/components/TransactionForm.svelte`):

- Promote Amount: large type (`text-3xl`, `tabular-nums`), currency symbol
  rendered _inside_ the field as a prefix affix, `inputmode="decimal"`.
  Put it directly under Title, above the metadata.
- Demote Date, Category, Currency into a quieter secondary group. **Hide the
  Currency picker entirely when the group is single-currency**, behind a
  "different currency?" toggle — it is noise for the overwhelming majority case.
- Drop the outer `Card` wrapper; the form doesn't need a border inside an
  already-constrained column.

## 3.3 "Paid by" and "Split between" are two identical checkbox lists

**Current state.** The same four member names appear twice, as two visually
identical checkbox columns, ~350px apart. On a 4-member group that is 8 rows of
names for what is almost always "I paid, split evenly".

**Fix.**

- **Paid by**: collapse to a single-select (the common case is one payer),
  rendered as a compact row of member chips with the actor preselected, plus a
  `Split across multiple payers` link that expands today's multi-payer checkbox
  list with per-payer amounts. Preserve the existing multi-payer form contract
  and hidden-input serialization exactly — this is a presentation change only.
- **Split between**: keep the checkbox list, but add `All` / `None` toggles and
  render it as wrapping chips rather than a full-width column.

**STOP condition.** `e2e/group-flow.spec.ts` asserts
`page.getByRole('group', { name: 'Paid by' }).getByRole('checkbox', { name })`
is checked. If Paid-by's default is no longer a checkbox, update that spec in
the same commit — do not leave the suite red.

## 3.4 No live preview of who owes what (except itemized)

**Current state.** Itemized mode has a genuinely good live "Breakdown" +
"Each person owes" panel. Equal / Amount / Share modes — the modes ~everyone
uses — show nothing. You cannot see that `¥6,800` split four ways is `¥1,700`
each until after saving.

**Fix.** Lift the breakdown panel out of the `splitMode === 'itemized'` branch
and render it for every mode. For `equal` it collapses to one line
(`¥1,700 each`); for `amount`/`share` it lists per-member resolved amounts and
surfaces the remainder/rounding allocation. The resolver is already
client-importable — this is a rendering change, not new math.

This is the highest-value single item in Stage 3: it converts the form from
"fill in and hope" to "see the result before you commit".

## 3.5 Itemized mode is ~2,200px tall on a phone

**Current state.** With two items and one charge the form is ~2,200px at 390px
wide. Each item repeats the full four-member checkbox list _and_ a three-tab
split-mode switcher. The `Item` and `Amount` inputs are squeezed to ~90px and
~110px (placeholder clips to `e.g. Piz:`) because a wide text `Remove` button
sits on the same row.

**Fix.**

- Collapse each item to a summary row (`Gyoza · ¥1,200 · split 4 ways`) that
  expands on tap; only one item open at a time.
- `Remove` becomes an icon button (trash), freeing ~80px for the inputs.
- Give each item's beneficiary list a "same as transaction" default so the
  member checkboxes only appear when the item actually differs.

## 3.6 Category silently defaults to "Food & Drink"

**Current state.** A new transaction arrives pre-set to Food & Drink. Users who
don't notice will file rent, flights, and taxis as food.

**Fix.** Default to an unset placeholder (`Choose a category`) and either
require it, or file unset as an explicit `Uncategorised`. Do not guess.

---

# Stage 4 — Visual design (P2, effort M)

## 4.1 The palette is stock shadcn neutral — zero chroma throughout

**Current state.** Every `--primary`, `--accent`, `--chart-*` in
`src/app.css` is `oklch(L 0 0)` — literally zero saturation. The primary button
is black, and the only colour anywhere in the product is `--destructive` red.
For a social money app, this reads as an unstyled scaffold rather than a
product.

**Fix.** Introduce one brand hue plus the two semantic money tokens from 2.4.
Suggested starting direction (a teal-green primary reads "money/settled" without
the fintech-blue cliché; **validate contrast before committing**):

```css
:root {
	--primary: oklch(0.55 0.13 175); /* brand teal */
	--primary-foreground: oklch(0.99 0 0);
	--money-positive: oklch(0.52 0.13 160); /* you're owed */
	--money-negative: oklch(0.55 0.19 25); /* you owe */
}
.dark {
	--primary: oklch(0.72 0.12 175);
	--primary-foreground: oklch(0.18 0.02 175);
	--money-positive: oklch(0.75 0.14 160);
	--money-negative: oklch(0.7 0.17 25);
}
```

Register the money tokens in the `@theme inline` block alongside the existing
ones so `text-money-positive` etc. resolve. Verify every pairing at ≥4.5:1
(≥3:1 for large text) in both themes before committing.

**Note.** The app already imports `mode-watcher` and ships a full `.dark` block,
but **no theme toggle is rendered anywhere**. Either add one to the header or
drop the dependency — right now dark mode only responds to nothing at all.

## 4.2 Desktop is a 640px phone column in a 1440px window

**Current state.** `src/routes/+layout.svelte` constrains everything to
`max-w-screen-sm` (640px). The groups list at 1440px is two small cards and
~700px of empty white below them. Individual pages then set `max-w-2xl` (672px)
inside that 640px shell — a conflict where the inner value can never take
effect.

**Fix.** Mobile-first stays the priority (PLAN §10), but "responsive" should
mean the layout _uses_ a large viewport:

- Raise the shell to `max-w-5xl` and let pages opt into narrower measures.
- Remove the dead `max-w-2xl` wrappers, or make the shell unconstrained and let
  each page own its width — one owner, not two.
- On `lg:`, give the group overview a two-column layout (balances + settle
  action in a sidebar; transactions and activity in the main column).
- Consider a two-up grid for the groups list at `md:`.

**STOP condition.** Do not break the phone layout to serve desktop. Screenshot
390px before and after; they must be equivalent.

## 4.3 Group navigation hides half its tabs on phone

**Current state.** `GroupNav` renders six tabs in a horizontally scrolling bar.
At 390px only **Overview, Transactions, Settle up** are visible — Members,
Activity, and Settings are off-screen with no scroll affordance, no fade, no
chevron. They are effectively undiscoverable on the app's primary form factor.

**Fix.** Either (a) add a right-edge gradient fade plus scroll-snap so the
overflow is visibly indicated, or (b) better for six destinations on a phone:
move to a bottom tab bar for the top 4 with the remainder behind a "More" sheet.
Option (a) is the S-effort fix; (b) is the right long-term answer and pairs
naturally with the existing `MobileActionBar` pattern.

## 4.4 Settle-up suggestions are a column of identical full-width black buttons

**Current state.** Each suggestion stacks `Priya → Alex Chen`, the amount, and
then a **full-width black `Settle up` button** on its own line. Three
suggestions fill the entire viewport with three equally-loud primary CTAs.

**Fix.** Inline the action on the right of each row at `size="sm"`,
`variant="outline"` (they are peers, not the page's primary action), keeping the
existing 44px touch target. The row then costs one line instead of three. The
`sm:flex-row` breakpoint already does this above 640px — the phone layout is the
one to fix.

## 4.5 Smaller consistency items

- **Settle page header lacks the `+ Add` button** that Overview and Transactions
  both have. Either add it or move `+ Add` into the shell for all group pages.
- **Activity feed is verbose**: every row reads `Alex Chen created [Transaction]`
  and then repeats the amount already shown in the summary line beneath. On the
  overview card, collapse to the summary line plus relative time. The
  `[Transaction]` entity badge adds nothing when every row is a transaction.
- **Header shows the raw email** when no display name is set, truncated at
  `40vw`. Prefer an avatar/initial with the name in a menu.
- **Group card padding**: `Card.Header` `px-6` + a two-line card yields ~125px
  per group. Tighten for list contexts.

---

## Verification (all stages)

```bash
pnpm check                 # 0 errors
pnpm test:unit             # all passing
pnpm test:e2e              # group-flow + auth specs green
```

Plus a manual screenshot pass at 390px and 1440px over: `/`, `/groups`,
`/groups/[id]`, `/groups/[id]/transactions`, `/groups/[id]/transactions/new`
(equal **and** itemized), `/groups/[id]/settle`, `/groups/[id]/members`.

## Global STOP conditions

- **No money-math changes.** Everything here is presentation. If an item seems
  to require touching `src/lib/money/**` beyond the additive `code` option in
  1.2, or `src/lib/server/balances.ts` beyond reuse in 2.2, stop and report.
- **No hand-authored `src/lib/components/ui/**`.** Those are shadcn CLI output
(`pnpm dlx shadcn-svelte@latest add <name>`). Fix call sites, not primitives —
  item 1.1 in particular is a call-site fix, not a card-header edit.
- **Progressive enhancement is a hard constraint** (PLAN §10). Every control
  changed here must still work as a plain form POST with JS disabled.
