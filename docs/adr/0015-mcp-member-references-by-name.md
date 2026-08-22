# ADR-0015 — MCP member references move from id to unique display name

- **Status:** Accepted — partially supersedes ADR-0006
- **Date:** 2026-08-22

## Context

ADR-0006 gave write tools (`create_transaction`, `update_transaction`, `settle_up`)
one rule for naming a member: **ids only**. Its reasoning was that the model's own
fuzzy match of a user's shorthand ("Nan") against a roster holding two plausible
members (`Nan Suphaporn`, `Nanthawat P.`) is where a wrong-but-valid pick happens,
and doing that match server-side would only move the guess, not remove it. The
chosen control was **legibility, not prevention**: the agent resolves the id
itself, visibly, and `similar-names.ts`'s post-write echo names the other
similarly-named member so a wrong pick is caught in the transcript.

That control assumed the agent's own resolution step stays visible to the person
reading the conversation. In practice it wasn't: a user reviewing a raw
`create_transaction` payload before it's sent sees `memberId: "a3f2e9d1-..."` and
has no way to independently confirm who that is — the only legibility on offer was
the agent's prose, which the user has to trust rather than verify. The literal
tool-call payload — the thing a careful user would actually want to check — stayed
opaque.

`displayName` today carries **no uniqueness guarantee** at all
(`members-schema.ts`): only `(group_id, user_id)` is unique, and only for linked
members. Two active, unlinked members can hold the identical string.

## Decision

**Enforce active-member display-name uniqueness per group**, and **switch
member-reference fields in MCP tools from id to name.**

### Uniqueness constraint

A partial unique index on `members.display_name`, normalized (NFC → trim →
lowercase; compared as a full string, not `similar-names.ts`'s first-token prefix
rule — that rule is a similarity *hint*, not an equality test), scoped to
`WHERE deactivated_at IS NULL`. Deactivated members are exempt: their name is free
to be reused, and renaming a deactivated member is never blocked by it, mirroring
the existing `members_group_id_user_id_unique` partial-index pattern.

Three call sites can produce a collision, and get two different responses:

- `addMember` / `renameMember` (an explicit admin action) → **hard-reject** with an
  actionable, self-correctable error (ADR-0009 shape).
- `reactivateMember` (§6.3's "simple flag flip") → today has no collision
  awareness at all. It must catch the constraint violation and hard-reject the
  same way, pointing the admin at renaming the deactivated member first — which
  stays possible precisely because the constraint doesn't apply to inactive rows.
- Invite-accept's new-member join path (§6.2) → **never blocks joining**. The
  display name defaults to the joining user's own account name, which they did
  not choose in that moment, so rejecting it would refuse a real person entry
  over a name coincidence. It auto-suffixes instead: `Nan`, `Nan (2)`, `Nan (3)`,
  scanning active members for the next free number. Telling the joiner their name
  was suffixed, so they can rename themselves, is a deliberate **follow-up**, not
  part of this decision — the mechanism is correct and rename-able without it.

### MCP surface

`create_transaction`, `update_transaction`, and `settle_up` drop id-acceptance for
member references **entirely** — not dual-accept. The server resolves a supplied
name via the same normalized, exact (non-fuzzy) match the uniqueness constraint
enforces; a name that doesn't match an active member is a `validation_error`, not
a silent no-op or a guess. Every field that held an id and is renamed to say what
it now holds: `beneficiaries[].memberId` → `memberName`, and `list_transactions`'
`memberId` filter → `memberName` for the same reason, even though it's a read-side
filter — leaving one lone id-based field after committing to names everywhere
else would just relocate the two-ways-to-refer-to-a-member problem rather than
remove it.

`get_transaction`'s `editable` object — the one ADR-0011 requires copying
verbatim into `update_transaction` — changes its member fields
(`EditableBeneficiaryView.memberId`, the top-level editable payer field) from id
to name too, so that read → copy → write round trip stays a straight copy instead
of requiring a translation step on the one payload meant to be copied faithfully.

Agent-facing read views that already show both (`list_members`,
`get_transaction`'s `PayerView`/`ShareView`) **keep both** id and `displayName`.
The id was never the problem; accepting it as *write input* was. Dropping it from
read output would remove a debugging/cross-reference handle for no safety gain,
since it's already inert as input everywhere else.

No data migration ships with this: the app is pre-production, and the team
accepted the risk of not reconciling any pre-existing duplicate names.

### What this does not fix

Full-name uniqueness only guarantees no two active members share the exact same
normalized string. It does nothing about ADR-0006's actual running example:
`Nan Suphaporn` and `Nanthawat P.` can both exist, both still get called "Nan"
colloquially, and both have distinct, fully unique, valid full names. The agent
still has to decide which full name a shorthand refers to before writing — and a
wrong-but-real guess still succeeds. `similar-names.ts`'s post-write "other Nan"
echo is **unchanged and still load-bearing**: it remains the only control for
that specific failure. What this ADR fixes is payload legibility (a name-based
payload is checkable by the user directly, not just through the agent's prose)
and typo/hallucination protection (a name matching nobody is now a loud error).
Revisiting `similar-names.ts`'s pre/post-write boundary to also narrow the
nickname-collision risk is explicitly out of scope here and would need its own
ADR, per that file's own stated boundary.

## Consequences

- ADR-0006's "IDs only in write-tool schemas" clause is reversed. Its `isYou`
  marker, untrusted-envelope naming, and the post-write similarity echo are
  **unchanged** — only the write-contract shape moves.
- A wrong id can no longer be silently accepted: every write-tool member
  reference is now a name the server resolves itself, with a self-correctable
  error on any miss.
- `addMember`, `renameMember`, and `reactivateMember` gain new failure modes
  (unique-violation → validation error) that did not exist before; invite-accept
  gains new success-path behavior (auto-suffix) that did not exist before.
- Every MCP write-tool schema, and one read-tool filter, changes its wire shape.
  Any existing caller passing a member id to these tools breaks — accepted, since
  there are no external integrations yet to preserve.
- The nickname-collision risk ADR-0006 was written for is explicitly still open,
  carried entirely by `similar-names.ts`, unchanged by this decision.
