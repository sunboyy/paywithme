# Autonomous build — protocol & operations

The canonical, **project-agnostic** contract for building an app hands-off from
`PLAN.md` via an implement → review → test → commit loop. The single source of
truth for _how_ the build runs.

**Reusing this harness:** copy `.claude/agents/`, `scripts/`, and this file, then
write a fresh `PLAN.md` (spec) and `CLAUDE.md` (conventions + a pointer here).
Decompose the spec into a **map issue + sub-issues** on the tracker (e.g. via
`/to-spec` then `/to-tickets`) rather than a `TASKS.md` file — see _Task tracker_
below. The protocol is otherwise unchanged between projects.

## Components

| Piece         | File(s)                                                  | Role                                                      | Reusable?             |
| ------------- | -------------------------------------------------------- | --------------------------------------------------------- | --------------------- |
| Orchestrator  | the `/loop` main agent (this protocol)                   | Picks tasks, runs gate + git, delegates, pauses per phase | ✅                    |
| Implementer   | `.claude/agents/implementer.md` (Opus)                   | Writes code + tests for one task                          | ✅                    |
| Reviewer      | `.claude/agents/reviewer.md` (Sonnet)                    | Independent review → APPROVE / CHANGES                    | ✅                    |
| Fast gate     | `scripts/gate.sh`                                        | lint + format + typecheck + unit (per task)               | ✅                    |
| Full gate     | `scripts/gate-full.sh`                                   | fast gate + e2e (per phase)                               | ✅                    |
| Spec          | `PLAN.md`                                                | _What_ to build                                           | ❌ per project        |
| Task tracker  | **GitHub Issues** (map issue + sub-issues, `blocked_by`) | Progress source-of-truth                                  | ✅ (issue-tracker.md) |
| Project guide | `CLAUDE.md`                                              | Project conventions + pointer here                        | ❌ per project        |
| Build branch  | `impl/autonomous-build`                                  | Where the loop commits                                    | ✅                    |

## Task tracker: GitHub Issues

Progress lives in **GitHub Issues**, managed via `gh` (see
`docs/agents/issue-tracker.md` › _Wayfinding operations_ for the exact commands).
The loop no longer reads **`TASKS.md`** (any such file is retired to a historical
record of earlier phases) — the three things a task file used to encode each map
to a native GitHub primitive:

| Old (`TASKS.md`)            | Now (GitHub)                                                       |
| --------------------------- | ------------------------------------------------------------------ |
| A **phase** (`## Phase N`)  | A **map/spec issue** with its tasks linked as **sub-issues**       |
| A **task** (checkbox + tag) | A **sub-issue** of that map                                        |
| `deps:` between tasks       | Native **`blocked_by`** dependency edges                           |
| The `§` a task cites        | Cited in the **sub-issue body** (the orchestrator slices those §s) |

**Status encoding** — a sub-issue's state _is_ its status; no separate marker:

| Lifecycle     | Represented as                                                   |
| ------------- | ---------------------------------------------------------------- |
| `todo`        | open · `ready-for-agent` · **no assignee** · `blocked_by == 0`   |
| `in-progress` | open · **assignee set** (the assignee _is_ the claim / lock)     |
| `in-review`   | open · assignee · `status:in-review`                             |
| `blocked`     | open · `status:blocked` (and/or `needs-info`) + a reason comment |
| `done`        | **closed**                                                       |

**Frontier** = open sub-issues of the current map with
`issue_dependencies_summary.blocked_by == 0` **and no assignee**; first in map
order wins. **The current map** is the earliest one with an open sub-issue.

**One-time setup** (per repo): labels `ready-for-agent`, `status:in-review`,
`status:blocked`, `needs-info`. Native sub-issues + issue dependencies must be
enabled (they are on GitHub by default).

> **Concurrency = single worker (v1).** At most **one** sub-issue is claimed
> (assigned) at a time — a faithful port of the old "at most one `in-progress`"
> invariant, just stored on GitHub. The claim lock (`--add-assignee`) and native
> dependencies are already the primitives a parallel pool needs; lifting the
> single-claim invariant to N workers is the **only** additional change (see
> _Parallel mode (future)_). Storage, frontier query, and close-on-commit are
> identical either way, so the upgrade is additive.

## How to run the build

Driven by the `/loop` skill in an interactive session; the main agent is the
**orchestrator**. Start or resume with:

```
/loop continue the autonomous build per docs/autonomous-build.md
```

The build commits to **`impl/autonomous-build`**. `main` advances only when the
human merges at phase boundaries. `gh` infers the repo from the git remote.

## Orchestrator loop (each tick)

1. **Resume check.** Query the current map's sub-issues for one that is open
   **with an assignee** (`status:in-progress`/`in-review`); if found, recover it
   (see _Resume contract_) before picking new work.
2. **Pick task.** Run the **frontier query** (open sub-issues, `blocked_by == 0`,
   no assignee, first in map order). **Claim it:** `gh issue edit <n> --add-assignee @me`
   — the claim is the concurrency lock and the session's first write.
   **Invariant:** at most one sub-issue is claimed at a time.
3. **Phase boundary.** If the frontier is empty (every sub-issue closed, or the
   only open ones carry `status:blocked`): run the **full gate**
   (`scripts/gate-full.sh`). If green → **STOP** and hand back to the human; do
   not start the next map. The hand-back must state whether the phase is **fully
   done** (all sub-issues closed) or **done-with-blocks** (some open +
   `status:blocked`), listing every blocked sub-issue with its reason
   (`NEEDS-INPUT:` / reviewer notes) from its comment. A `blocked` task is
   reported, not waited on — it does not prevent the boundary stop.
4. **Implement.** Spawn the **`implementer`** (Opus) with the sub-issue body and
   the **text of the `PLAN.md` sections it cites** — not the whole file (see
   _Context scoping_). It writes code **and** tests.
5. **Fast gate.** Run `scripts/gate.sh` (lint + prettier + typecheck + unit). If
   red, hand failures back to the implementer (draws from the shared 3-round
   budget, step 7); do not review until green.
6. **Review.** Add `status:in-review` (`gh issue edit <n> --add-label status:in-review`).
   Spawn the **`reviewer`** (Sonnet) with the sub-issue body, the **same cited
   `PLAN.md` sections** passed in step 4 (see _Context scoping_), and the full
   diff **including new files** — use `git add -A && git diff --staged` (a bare
   `git diff` omits the untracked files that scaffolding tasks create). It returns
   **APPROVE** or findings.
7. **Iterate.** On findings or a red gate, remove `status:in-review` and send them
   back to the implementer. Red-gate fixes and review findings share **one budget
   of 3 rounds** per task. If the budget is exhausted while still red or
   unapproved → mark the sub-issue `blocked` (`--add-label status:blocked` + a
   comment with the reviewer notes, or failing gate output if review was never
   reached) and continue with other tasks.
8. **Commit & close.** On APPROVE **and** green fast gate: commit (see _Commit
   format_), then **close the issue** (`gh issue close <n>`) — closing
   automatically unblocks its dependents via native dependencies.
9. **Reschedule** the loop and repeat.

The orchestrator never writes feature code — it only manages issue status
(assign / label / close), runs the gate/git, and delegates to the two subagents.

## Context scoping (token discipline)

`PLAN.md` is the canonical spec but large; loading all of it into every subagent
each task is the build's biggest avoidable token cost. So the orchestrator passes
a subagent **only the `PLAN.md` sections the task cites** (by `§` number, read
from the sub-issue body), as text — slice them straight from `PLAN.md` at their
`##`/`###` headers. Pass the **same** slice to the implementer (step 4) and
reviewer (step 6) so both judge against identical spec text.

The on-disk spec stays authoritative: if a provided section points elsewhere
(`see §X`), the subagent opens `PLAN.md` and reads **just that section** — never
the whole file. `CLAUDE.md` conventions are always in context, so they're never
re-pasted.

## Task lifecycle

```
todo ──> in-progress ──> in-review ──> done
            ▲   │            │
            └───┘            │   (iterate: review/gate sends it back)
            │                │
            └──> blocked <───┘   (shared budget of 3 rounds exhausted, or NEEDS-INPUT)
```

Status is the sub-issue's own state (see _Task tracker_): open+assignee =
`in-progress`; `+ status:in-review`; closed = `done`; `+ status:blocked` =
blocked. Only the orchestrator changes issue status.

**Blocked dependents are automatic.** A `blocked` task stays **open**, so every
task that (transitively) depends on it keeps `blocked_by > 0` and never appears on
the frontier — no manual propagation needed. They re-enter the frontier the moment
the blocker is resolved and **closed**.

## Quality gates

- **Fast gate** (`scripts/gate.sh`, every task): ESLint, Prettier check, type
  check, unit tests. Must be green to commit.
- **Full gate** (`scripts/gate-full.sh`, phase boundary): fast gate + e2e. Must
  be green before the human merge pause.
- Both no-op cleanly before Phase 1 scaffolds `package.json`. After scaffold, the
  implementer wires these `package.json` scripts so the gate has teeth: `lint`,
  `format:check`, `check`, `test:unit`, `test:e2e`.

## Commit format

One commit per completed task. Conventional commits, referencing the **issue**:

```
<type>(<scope>): <summary> (#<issue>)

<what/why, 1–3 lines>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

Commit only when the fast gate is green **and** the reviewer approved, then
`gh issue close <n>` (step 8). Do **not** rely on a `Closes #n` keyword to
auto-close: the loop commits to `impl/autonomous-build`, and GitHub only
auto-closes on merge to the **default** branch — so close explicitly at commit
time (the merge to `main` then reconciles cleanly).

## Phase boundary (human checkpoint)

When the current map has no actionable sub-issue left (all closed, or the only
open ones are `status:blocked`) and the full gate is green, the loop stops and
reports the phase status — **fully done** or **done-with-blocks** (listing each
blocked sub-issue and reason) per loop step 3 — then asks the human to:

```
git checkout main
git merge --no-ff impl/autonomous-build
git checkout impl/autonomous-build   # continue next phase here
```

Then restart the loop. The loop **never auto-merges to `main`** — that's the
human's per-phase checkpoint.

## Resume contract (continuable across token-out / API error)

State lives **on GitHub and in git**, never only in context, so any fresh session
can resume:

1. A fresh session reads `CLAUDE.md` + this file + the current **map issue and its
   open sub-issues** (`gh issue view`).
2. If a sub-issue is open **with an assignee** (`status:in-progress`), run
   `scripts/gate.sh` on the working tree:
   - **green** → review → commit + close (resume at loop step 6);
   - **red / partial** → implementer **continues** the existing working tree (do
     **not** discard partial work).
3. Closed issues are immutable history; only the one assigned-open sub-issue can be
   partial.

Because the orchestrator **assigns** a sub-issue _before_ delegating and **closes**
it only _after_ committing, there is always exactly one recoverable point of
uncertainty (the claimed task), with its partial work preserved in the tree.

## Blocked / external inputs

Tasks needing real secrets/assets only the human can supply are found by
`gh issue list --label needs-info`. For these: build the local-dev path, mark the
dependent sub-issue `blocked` (`status:blocked` + `needs-info` + a `NEEDS-INPUT:`
comment), and continue. Supply the inputs when prompted; blocked tasks re-enter
the frontier in a later pass once resolved and their blocker closed. Never
hard-code secrets — everything via `.env` (documented in `.env.example`).

## Parallel mode (future)

The single-worker invariant (loop step 2) is the **only** thing standing between
this protocol and parallel subagents; the storage, frontier query, claim lock, and
close-on-commit are already parallel-safe. To lift it:

- **Fan out.** Claim **every** frontier sub-issue at once (up to a worker cap) and
  spawn an implementer per claim. `--add-assignee` is an atomic claim, so two
  workers can never grab the same issue.
- **Isolate the tree.** Parallel workers cannot share one working tree (gate runs
  and commits collide) — give each a **git worktree** (or branch-per-issue) and
  merge each into `impl/autonomous-build` on its own commit + close.
- **Re-fan on completion.** Each close unblocks dependents; re-run the frontier
  query and claim the newly-open issues. The graph drains itself (e.g. closing the
  write-endpoints issue opens the idempotency/rate-limit/audit/docs fan-out).

Everything else in this document — gates, review, commit format, resume, phase
boundary — is unchanged. Adopt when token budget allows.

## Guardrails

- Orchestrator writes no feature code — only issue status (assign / label / close),
  gate runs, and git.
- Implementer never commits, and never changes issue status.
- Reviewer never edits files.
- No secrets in git.
- The loop never auto-merges to `main`.
