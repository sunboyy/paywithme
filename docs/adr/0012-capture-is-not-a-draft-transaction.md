# ADR-0012 — A record-later Capture is its own entity, not a draft transaction

- **Status:** Proposed
- **Date:** 2026-07-29

## Context

The moment a shared expense happens is the worst moment to record it. You are
leaving a restaurant, splitting a bill four ways, and the app wants a category, a
split mode, payers, and beneficiaries. So the transaction doesn't get recorded —
and by the time there _is_ time, the memory of it is gone too.

The data model already handles the _late_ part. PLAN §7.1 deliberately makes
`created_at` the **editable real-world date** (backdatable) and `occurred_at` the
**immutable insert time**. Recording Saturday's dinner on Tuesday, dated Saturday,
is already correct and already supported. Nothing about the ledger needs to change
to allow late entry.

What's missing is a way to say **"this exists"** in a few seconds, and something
that brings you back to it later.

The obvious implementation is a `status: draft` column on `transactions`. That is
the decision this ADR rejects.

## Decision

A record-later note is a **Capture** — a separate, deliberately shallow table —
**not** a transaction in a draft state.

```
captures  (id, group_id, created_by,
           note,                    -- free text, the only required content
           amount_minor?, currency?, -- both nullable; no rate, no conversion
           captured_for,            -- real-world date, defaults today
           resolved_transaction_id?, resolved_at?,
           created_at)
```

Three rules make it work:

**1. It stays shallow.** No payers, no beneficiaries, no split mode, no FX rate,
no itemization. If you had time to fill those in, you had time to record the
transaction. A Capture that can hold structured splits is a second transaction
form, and then there are two to maintain and two to keep correct.

**2. It never reaches the ledger.** §8 balance math, `/settle`, and the MCP
transaction tools do not read `captures` at all — not even as a provisional
"±฿1,200 pending" annotation on a balance. A number not backed by resolved shares
is a number people will act on.

**3. Resolving is a conversion, not a mutation.** "Record it" opens
`/groups/[id]/transactions/new` prefilled from the note, amount, and date. On
save, the Capture is stamped `resolved_transaction_id` + `resolved_at` — it is
never deleted, so the trail from "I remembered this on Saturday" to "I recorded it
on Tuesday" survives.

Captures are **visible to the whole group**, and each carries its author.

## Why not `status: draft` on `transactions`

The transactions table's invariants are exactly the ones a half-remembered
purchase cannot satisfy. `amount_total` and `amount_total_settlement` are NOT
NULL; §7.4 requires payer amounts to sum to the total and shares to sum to the
total; §7.6 requires a positive rate whenever the currency is foreign. A draft has
none of that resolved.

Admitting drafts means relaxing those columns and skipping those checks — **for
every row in the table, forever**, since a constraint is only as strong as its
weakest permitted state. The invariants that keep the ledger from silently
drifting would then hold by convention rather than by construction.

And every consumer would need a `status <> 'draft'` filter or it double-counts:
the balance engine, `/settle`, `/api/v1` transaction listing, MCP
`list_transactions`, the activity feed, the group overview. That is the same
footgun class as `deleted_at`, which the codebase already carries — and two
overlapping exclusion flags interact, so the wrong combination is a plausible bug
rather than an obvious one.

Against that, the cost of a separate table is one more listing surface and one
conversion flow. It is the cheaper side.

## Consequences

- **The ledger's invariants are untouched.** No column becomes nullable, no
  validation rule in §7.4 gains an exemption, and no existing query needs a new
  filter. A Capture cannot corrupt a balance because nothing that computes
  balances can see it.
- **Group visibility deduplicates.** The non-obvious win is not social pressure:
  if two people paid parts of the same dinner, a visible "Sur — dinner, ~฿1,200,
  not recorded yet" stops the second person entering it a second time. This is a
  real hazard in shared-expense apps and it is why Captures are not private.
- **`note` is Member-authored text** (`CONTEXT.md`) — untrusted wherever it
  reaches an agent, and always attributed to its author. It is prefilled into a
  transaction title on resolve, which is a human-reviewed step, not an automatic
  one.
- **Creating and resolving a Capture writes an `audit_log` row** in the same DB
  transaction, per PLAN §12.1 — a group-visible mutation is a mutation.
- **The word "Capture" is internal.** No user-facing string says it; the UI says
  **"Not recorded yet"**. The domain needed a noun that doesn't collide with
  "placeholder" (§6.2's unlinked member slots) or "pending" (§16.6's idempotency
  rows); users don't need one.
- **The fastest capture path is the Connector, not the form.** The friction being
  solved is reaching for the app at all, so a `create_capture` write tool (plus a
  read-side `list_captures`) means one spoken sentence on the walk out —
  _"note in the trip group that I paid for dinner, about 1,200 baht, I'll split it
  later"_ — and later, _"what haven't I recorded?"_. The shallow shape is what
  makes this safe to hand an agent: there is no split for it to get wrong, and
  amount stays a decimal string per ADR-0004.
- **Recall is in-app only.** Push notifications are out of scope (§1), so the
  mechanism is a persistent unrecorded count on `/groups` and the group overview
  plus a "Not recorded yet" tray. Two adjacent options are deliberately deferred,
  not designed here: the **PWA app badge** (`navigator.setAppBadge` — no push
  server, but it needs an explicit ruling on whether §1's exclusion covers it) and
  an **email nudge** (`sendEmail` exists; a scheduler does not).
- **Captures require a group.** "I don't remember which group this was" is
  deliberately not solved — a Capture nobody can see is a reminder with no
  deduplication value and no home.
- **If Captures start accumulating unresolved, the feature has failed** in a
  visible way, which is the intent. They are a queue to empty, not an archive.
