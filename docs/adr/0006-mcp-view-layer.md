# ADR-0006 — MCP gets its own view layer, not the `/api/v1` DTOs

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

Two gaps forced this decision.

**The agent cannot identify the user.** `settle_up` needs `from` (payer) and `to`
(payee). `to` is obtainable from `list_members`. `from` is _the user's own member
id in that group_ — and nothing in the API reveals it. `MemberDto` carries `id`,
`displayName`, `userId`, `deactivatedAt`, `isLinked`, but **no self marker**, and
there is no `whoami`. The agent's only recourse would be to guess from a display
name, which is the wrong-payee failure below, guaranteed rather than occasional.

**The agent can pick the wrong real person.** The server already rejects
_hallucinated_ member ids (settle-up "re-validates against the group's active
members (an unknown `from`/`to` → 422)"). But an agent matching "Nan" against
`Nan Suphaporn` and `Nanthawat P.` can pick the wrong one — and that write is
valid, passes every guard, and misattributes money between two real people.

Serving these needs from `lib/server/api/v1`'s DTOs would drag agent-only concerns
into a **published REST contract with an OpenAPI spec and consumers**.

## Decision

A **separate MCP view layer** (`src/lib/server/mcp/`), over the same `lib/server`
services. Not a reuse of the v1 DTOs.

It owns, and only it owns:

- **`isYou`** on members, computed server-side from the API key's owner.
  `settle_up` **defaults `from` to the caller's own member** when omitted (an
  explicit `from` remains allowed — recording that A paid B on others' behalf is a
  real flow).
- **IDs only** in write-tool schemas. No server-side fuzzy name matching in the
  money path. The agent calls `list_members` and matches the name _itself,
  visibly, in the transcript_, where the user can see the reasoning.
- **Prose echo-back naming the humans**, so a wrong pick is legible at the moment
  it happens rather than discovered later:

  > _"Recorded settle-up: you → **Nan Suphaporn**, THB 1,200.00. (The other 'Nan'
  > in this group is Nanthawat P. — not involved.)"_

- **Untrusted-text envelopes** (ADR-0003), **decimal amounts** (ADR-0004),
  **`hasMore` + steering notes** (ADR-0008).

## Consequences

- `/api/v1` and its OpenAPI contract are **untouched**. The two surfaces diverge
  deliberately: REST is for developers reading a spec; MCP is for a language model
  reading tool descriptions. They are different presentations of one domain, and
  their needs genuinely conflict (minor units vs decimal strings is the sharpest
  case).
- Two mappers to keep in step with the domain. Accepted: the alternative is one
  mapper serving two contradictory contracts.
- The real control on wrong-payee is **legibility, not prevention**. We do not stop
  the agent picking wrong; we make a wrong pick something the user reads in plain
  language before they walk away.
