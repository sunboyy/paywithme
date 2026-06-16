# Autonomous build — protocol & operations

The canonical, **project-agnostic** contract for building an app hands-off from
`PLAN.md` via an implement → review → test → commit loop. The single source of
truth for _how_ the build runs.

**Reusing this harness:** copy `.claude/agents/`, `scripts/`, and this file, then
write a fresh `PLAN.md` (spec), `TASKS.md` (decomposition), and `CLAUDE.md`
(conventions + a pointer here). The protocol below is unchanged between projects.

## Components

| Piece         | File(s)                                | Role                                                      | Reusable?      |
| ------------- | -------------------------------------- | --------------------------------------------------------- | -------------- |
| Orchestrator  | the `/loop` main agent (this protocol) | Picks tasks, runs gate + git, delegates, pauses per phase | ✅             |
| Implementer   | `.claude/agents/implementer.md` (Opus) | Writes code + tests for one task                          | ✅             |
| Reviewer      | `.claude/agents/reviewer.md` (Sonnet)  | Independent review → APPROVE / CHANGES                    | ✅             |
| Fast gate     | `scripts/gate.sh`                      | lint + format + typecheck + unit (per task)               | ✅             |
| Full gate     | `scripts/gate-full.sh`                 | fast gate + e2e (per phase)                               | ✅             |
| Spec          | `PLAN.md`                              | _What_ to build                                           | ❌ per project |
| Task tracker  | `TASKS.md`                             | Progress source-of-truth                                  | ❌ per project |
| Project guide | `CLAUDE.md`                            | Project conventions + pointer here                        | ❌ per project |
| Build branch  | `impl/autonomous-build`                | Where the loop commits                                    | ✅             |

## How to run the build

Driven by the `/loop` skill in an interactive session; the main agent is the
**orchestrator**. Start or resume with:

```
/loop continue the autonomous build per docs/autonomous-build.md
```

The build commits to **`impl/autonomous-build`**. `main` advances only when the
human merges at phase boundaries. No git remote is configured; everything is
local (add one with `git remote add origin <url>` to back up).

## Orchestrator loop (each tick)

1. **Resume check.** If a task is `in-progress` in `TASKS.md`, recover it (see
   _Resume contract_) before picking new work.
2. **Pick task.** Select the first `todo` task in the current phase whose
   dependencies are `done` and that is not `blocked`; mark it `in-progress`. The
   **current phase** is the earliest with a task not `done`/`blocked`, inferred
   from `TASKS.md` (no separate on-disk marker). **Invariant:** at most one task
   is `in-progress` at a time.
3. **Phase boundary.** If no _actionable_ task remains in the phase (all `done`
   or `blocked`): run the **full gate** (`scripts/gate-full.sh`). If green →
   **STOP** and hand back to the human; do not start the next phase. The hand-back
   must state whether the phase is **fully done** (all `done`) or
   **done-with-blocks** (some `blocked`), listing every `blocked` task with its
   reason (`NEEDS-INPUT:` or reviewer notes). A `blocked` task is reported, not
   waited on — it does not prevent the boundary stop.
4. **Implement.** Spawn the **`implementer`** (Opus) with the task spec and the
   **text of the `PLAN.md` sections the task cites** — not the whole file (see
   _Context scoping_). It writes code **and** tests.
5. **Fast gate.** Run `scripts/gate.sh` (lint + prettier + typecheck + unit). If
   red, hand failures back to the implementer (draws from the shared 3-round
   budget, step 7); do not review until green.
6. **Review.** Mark the task `in-review`. Spawn the **`reviewer`** (Sonnet) with
   the task spec, the **same cited `PLAN.md` sections** passed in step 4 (see
   _Context scoping_), and the full diff **including new files** — use
   `git add -A && git diff --staged` (a bare `git diff` omits the untracked files
   that scaffolding tasks create). It returns **APPROVE** or findings.
7. **Iterate.** On findings or a red gate, send them back to the implementer
   (mark `in-progress` again). Red-gate fixes and review findings share **one
   budget of 3 rounds** per task. If the budget is exhausted while still red or
   unapproved → mark the task `blocked` with the reviewer notes (or failing gate
   output, if review was never reached) and continue with other tasks.
8. **Commit.** On APPROVE **and** green fast gate: commit (see _Commit format_)
   and mark the task `done` in `TASKS.md` (commit that too).
9. **Reschedule** the loop and repeat.

The orchestrator never writes feature code — it only edits `TASKS.md`, runs the
gate/git, and delegates to the two subagents.

## Context scoping (token discipline)

`PLAN.md` is the canonical spec but large; loading all of it into every subagent
each task is the build's biggest avoidable token cost. So the orchestrator passes
a subagent **only the `PLAN.md` sections the task cites** (by `§` number), as
text — slice them straight from `PLAN.md` at their `##`/`###` headers. Pass the
**same** slice to the implementer (step 4) and reviewer (step 6) so both judge
against identical spec text.

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

Status lives in `TASKS.md` as a checkbox + `@status` tag per task. The
orchestrator sets `in-progress` (step 2), `in-review` (step 6, flipping back to
`in-progress` on each iterate), `done` (step 8), or `blocked` (step 7). Only the
orchestrator edits `TASKS.md`.

**Blocked dependents.** A `blocked` task is never `done`, so step 2 won't pick
anything depending on it — its dependents would stall silently. So when a task
becomes `blocked`, also mark every task that (transitively) depends on it
`blocked` with a `blocked-by:<id>` note, making the stall visible in `TASKS.md`
and at the phase boundary. Such tasks auto-unblock when the blocker resolves.

## Quality gates

- **Fast gate** (`scripts/gate.sh`, every task): ESLint, Prettier check, type
  check, unit tests. Must be green to commit.
- **Full gate** (`scripts/gate-full.sh`, phase boundary): fast gate + e2e. Must
  be green before the human merge pause.
- Both no-op cleanly before Phase 1 scaffolds `package.json`. After scaffold, the
  implementer wires these `package.json` scripts so the gate has teeth: `lint`,
  `format:check`, `check`, `test:unit`, `test:e2e`.

## Commit format

One commit per completed task. Conventional commits, referencing the task id:

```
<type>(<scope>): <summary>  [<task-id>]

<what/why, 1–3 lines>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

Commit only when the fast gate is green **and** the reviewer approved. Commit the
`TASKS.md` status change with (or right after) the task.

## Phase boundary (human checkpoint)

When a phase has no actionable task left (all `done` or `blocked`) and the full
gate is green, the loop stops and reports the phase status — **fully done** or
**done-with-blocks** (listing each blocked task and reason) per loop step 3 —
then asks the human to:

```
git checkout main
git merge --no-ff impl/autonomous-build
git checkout impl/autonomous-build   # continue next phase here
```

Then restart the loop. The loop **never auto-merges to `main`** — that's the
human's per-phase checkpoint.

## Resume contract (continuable across token-out / API error)

State lives **on disk and in git**, never only in context, so any fresh session
can resume:

1. A fresh session reads `CLAUDE.md` + this file + `TASKS.md`.
2. If a task is `in-progress`, run `scripts/gate.sh` on the working tree:
   - **green** → review → commit (resume at loop step 6);
   - **red / partial** → implementer **continues** the existing working tree (do
     **not** discard partial work).
3. Committed tasks are immutable history; only the current task can be partial.

Because the orchestrator marks a task `in-progress` _before_ delegating and
`done` only _after_ committing, there is always exactly one recoverable point of
uncertainty (the current task), with its partial work preserved in the tree.

## Blocked / external inputs

Tasks needing real secrets/assets only the human can supply are listed in the
_Blocked / NEEDS-INPUT register_ in `TASKS.md`. For these: build the local-dev
path, mark the dependent part `blocked` with a `NEEDS-INPUT:` note, and continue.
Supply the inputs when prompted; blocked tasks are unblocked in a later pass.
Never hard-code secrets — everything via `.env` (documented in `.env.example`).

## Guardrails

- Orchestrator writes no feature code — only `TASKS.md`, gate runs, and git.
- Implementer never commits or edits `TASKS.md`.
- Reviewer never edits files.
- No secrets in git.
- The loop never auto-merges to `main`.
