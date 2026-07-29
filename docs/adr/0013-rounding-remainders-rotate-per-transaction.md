# ADR-0013 — Rounding remainders rotate per transaction, not always to the lowest `member_id`

- **Status:** Proposed
- **Date:** 2026-07-29

## Context

100 THB split equally three ways is 3 333 satang each with one satang left over.
Somebody pays 33.34. PLAN §7.2 decides who:

> **Rounding:** distribute remainders deterministically (largest-remainder) so
> resolved shares sum exactly to the total in minor units. **Tie-break:** equal
> remainders give the leftover minor unit to the **lower `member_id`**
> (ascending), so distribution is fully reproducible and unit-testable.

That rule is implemented once, in `distribute()` (`src/lib/money/money.ts`), and
every split, charge allocation and FX distribution funnels through it. The
determinism goal is met.

The fairness goal is not, for two reasons that only became visible once the ids
were real.

**`member_id` is a UUID, not a sequence.** `members.id` is
`text().$defaultFn(() => crypto.randomUUID())`. `compareMemberIds` tries a numeric
comparison, gets `NaN`, and falls back to lexicographic string order. So "the
lower `member_id`" resolves to _whoever's random UUID happens to sort first_ — not
the payer, not the group's creator, not the first name on the form. PLAN's
phrasing reads as though it assumed incrementing integer ids.

**The tie-break is a pure function of the id set, so it never varies.** In a
fixed group of three, the member with the lexicographically smallest UUID absorbs
the extra satang on _every_ unevenly-divisible equal split, forever. One satang is
nothing; the same person losing it on every split for a year is a small, real,
systematic bias — and it is the kind of thing users notice and lose trust over,
because it looks like the app has picked a favourite.

The requirement this ADR serves: **three identical 100 THB transactions should
leave each of the three members having paid 33.34 exactly once.**

## Decision

Keep largest-remainder. Replace the _tie-break_ with a rotation keyed on a stored
per-group transaction ordinal.

**1. A transaction carries a rotation ordinal.** `transactions.rounding_seq`
(integer, NOT NULL) assigned at insert from a per-group counter
(`groups.next_rounding_seq`, incremented in the same DB transaction as the write).
It is stored, not derived, so re-editing a transaction re-resolves to byte-identical
shares. Deleted transactions keep their ordinal; the counter never reuses a value
and rotation simply skips it.

**2. Ties rotate; largest-remainder still dominates.** `distribute()` gains an
offset. Beneficiaries are ranked by ascending `member_id` as today, then that
ranking is rotated by the offset:

```
rank(m) = (indexInIdSortedList(m) - (offset mod n) + n) mod n
```

Leftover units go to the largest remainders first, exactly as now; `rank` replaces
raw `member_id` order **only where remainders are equal**. Equal splits are all
tie, so they rotate fully. `share` mode, itemized aggregation and FX distribution
have genuinely unequal remainders almost always, so their behaviour is unchanged
in practice while staying deterministic.

With members A < B < C and one leftover satang: `seq=0` → A, `seq=1` → B,
`seq=2` → C. Three identical splits, one 33.34 each. That is the requirement.

**3. The offset is `rounding_seq + lineOrdinal`.** An itemized receipt runs
`distribute()` once per line item. A single offset for the whole transaction would
hand _every_ item's leftover to the same member — worse than today on a long
receipt. Adding the item's index spreads the residue within the transaction too.
Non-itemized transactions are one line, ordinal 0.

**4. Ascending `member_id` remains the final fallback** (and the `index` fallback
below it), so nothing becomes non-deterministic: given the same inputs _and the
same stored ordinal_, the output is identical.

## Why not exact fractions

Storing shares as rationals (`10000/3` satang) rather than rounding at all was the
other candidate. It moves the problem rather than solving it, and it moves it
somewhere worse.

- **Settle-up still rounds.** Nobody transfers 33.333 THB. The tie-break question
  reappears one layer down, at the moment real money moves — the point at which it
  actually matters and is hardest to explain.
- **Displayed shares stop reconciling.** Three exact thirds render as
  33.33 / 33.33 / 33.33 = 99.99 against a 100.00 total. Making resolved shares sum
  exactly to the total in minor units is the property largest-remainder exists to
  guarantee, and this gives it up.
- **The integer-minor-unit invariant is load-bearing everywhere.**
  `transaction_share.amount_owed`, the balance engine, the greedy settle-up
  matcher, the audit log and the MCP decimal-string contract (ADR-0004) are all
  integer minor units end to end. Rationals would touch every one of them and
  still end in a rounding rule.

## Why not seed the rotation on the transaction id

A hash of the transaction's UUID needs no new column and no counter, and it is
deterministic and re-editable. It is rejected because it is _random_, not
_rotating_: three identical transactions draw with replacement, so the same member
can take the extra satang all three times. That is the current complaint with
extra steps.

## Why not a running residue ledger

Tracking how many leftover units each member has absorbed and giving the next one
to whoever has absorbed fewest is the fairest rule available, and it self-corrects.
It is rejected because it makes share resolution **stateful and order-dependent**:
resolving transaction N would depend on the resolutions of 1…N-1, so editing,
deleting or restoring an old transaction should logically re-rotate every later
one. Today every transaction resolves independently and reproducibly from its own
stored inputs, which is what makes the ledger auditable. A stored ordinal buys most
of the fairness without giving that up.

## Consequences

- **The client-side split preview can no longer name who pays the extra unit.**
  `resolveShares` is deliberately not server-only — `TransactionForm.svelte` calls
  the same resolver to show the split before saving (that preview exists so you can
  see the split _before_ committing). An unsaved transaction has no
  `rounding_seq`. So an uneven equal split must preview as the floor for everyone
  plus an explicit "+฿0.01 to one member, assigned on save" — honest about what
  isn't decided yet. Handing the form a provisional next-seq at `load` time was
  considered and rejected: a concurrent write takes the ordinal first and the
  preview becomes confidently wrong, which is worse than vague.
- **PLAN §7.2 must be amended.** Its tie-break sentence is the normative statement
  of the current rule and would otherwise contradict this ADR. §7.2.3
  (charge/discount allocation) and §7.6 (FX distribution) inherit the same
  sentence by reference and are covered by the same amendment.
- **One new column on `transactions`, one on `groups`, one new parameter on
  `distribute()`.** The blast radius is small precisely because the rounding rule
  was implemented once and shared; this is the payoff for that.
- **The migration does not backfill; a separate opt-in script does.** An earlier
  draft assigned historical transactions an ordinal by `created_at` order inside the
  migration itself. That is wrong twice over: an edit **re-resolves** a transaction,
  so a silently backfilled ordinal would move a long-settled transaction's shares
  the first time anyone corrected its title; and `created_at` is the user-editable
  real-world date (§7.1), so ordering by it lets a backdate reshuffle every later
  ordinal. The migration therefore leaves every pre-existing row at ordinal 0 — the
  value that reproduces what they were originally resolved under, keeping
  `updateTransaction` byte-identical for them — and rotation begins with the first
  transaction written afterwards.

  Correcting history is a **separate, deliberate act**, available as
  `pnpm rounding:recalculate` (`src/lib/server/rounding-backfill.ts`). It previews by
  default and only writes with `--apply`, orders ordinals by the immutable
  `occurred_at`, re-resolves through the same resolver rather than any parallel
  implementation, writes a `recalculate` audit row per changed transaction, and is
  idempotent. It is a script and not a migration because it moves real balances: a
  group that had settled to exactly zero can come back at ±0.01, which is worse than
  the imbalance it corrects unless someone has decided they want it.

- **The tie-break stops being expressible as "lowest id wins"** in a single
  sentence, which is a genuine cost to explain — in tests and to a user asking why
  they paid the extra satang. The mitigating answer is a better one than today's:
  _it takes turns._
