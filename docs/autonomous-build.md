# Autonomous build — operations guide

How "Pay with me" gets built hands-off from `PLAN.md`, and how to operate,
pause, resume, and recover the loop. The short contract lives in `CLAUDE.md`;
this is the detail.

## Components

| Piece | File(s) | Role |
|---|---|---|
| Orchestrator | the `/loop` main agent, per `CLAUDE.md` | Picks tasks, runs gate + git, delegates, pauses per phase |
| Implementer | `.claude/agents/implementer.md` (Opus) | Writes code + tests for one task |
| Reviewer | `.claude/agents/reviewer.md` (Sonnet) | Independent review → APPROVE / CHANGES |
| Task tracker | `TASKS.md` | Single source of truth for progress (git-backed) |
| Fast gate | `scripts/gate.sh` | lint + format + typecheck + unit (per task) |
| Full gate | `scripts/gate-full.sh` | fast gate + Playwright e2e (per phase) |
| Build branch | `impl/autonomous-build` | Where the loop commits |

## Operating the loop

**Start / resume:**
```
/loop continue the autonomous build per CLAUDE.md
```

**At a phase boundary** the loop runs the full gate, then stops and asks you to:
```
git checkout main
git merge --no-ff impl/autonomous-build
git checkout impl/autonomous-build   # continue next phase here
```
Then restart the loop for the next phase. (No remote is configured; all local.
Add one with `git remote add origin <url>` and push if you want off-machine
backup later.)

## Task lifecycle

```
todo ──> in-progress ──> in-review ──> done
                  │            │
                  └──> blocked <┘   (3 failed review rounds, or NEEDS-INPUT)
```

Status is tracked in `TASKS.md` via the checkbox + a `@status` tag per task.
Only the orchestrator edits `TASKS.md`.

## Quality gates

- **Fast gate** runs on every task; must be green to commit.
- **Full gate** runs at each phase boundary; must be green before the merge pause.
- Both no-op cleanly before Phase 1 scaffolds `package.json`. After scaffold, the
  implementer must wire these `package.json` scripts so the gate has teeth:
  `lint`, `format:check`, `check`, `test:unit`, `test:e2e`.

## Resume / crash recovery

The system is designed to survive token-out and API errors because **all state
is on disk + git**, never only in conversation context:

1. A fresh session reads `CLAUDE.md` + `TASKS.md`.
2. If a task is `in-progress`, run `scripts/gate.sh` on the working tree:
   - green → review → commit (resume mid-loop);
   - red/partial → implementer **continues** the existing working tree.
3. Committed tasks are immutable history; only the current task can be partial.

Because the orchestrator marks a task `in-progress` *before* delegating and only
marks it `done` *after* committing, there is always exactly one recoverable point
of uncertainty (the current task), and its partial work is preserved in the
working tree.

## Blocked / external inputs

Tasks needing real secrets/assets (PLAN #24 credentials, #25 brand assets) are
built against the local-dev path (local Postgres, console-logged magic link,
placeholder assets), the dependent part is marked `blocked` with a `NEEDS-INPUT:`
note, and the loop continues. Provide these when prompted; then the blocked tasks
can be unblocked in a later pass.

## Guardrails

- Orchestrator writes no feature code — only `TASKS.md`, gate runs, and git.
- Implementer never commits or edits `TASKS.md`.
- Reviewer never edits files.
- No secrets in git; everything via `.env` (documented in `.env.example`).
- The loop never auto-merges to `main` — that is the human's per-phase checkpoint.
