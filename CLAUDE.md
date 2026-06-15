# Pay with me — Project & Autonomous Build Contract

This repo is built **autonomously** from [`PLAN.md`](./PLAN.md) by an
implement → review → test → commit loop. This file is the contract every session
reads. The product spec is `PLAN.md` (authoritative for *what* to build); this
file governs *how* the build runs.

> Full operational detail: [`docs/autonomous-build.md`](./docs/autonomous-build.md).
> Task tracker / source of truth for progress: [`TASKS.md`](./TASKS.md).

---

## How to run the build

The build is driven by the `/loop` skill in an interactive session. The main
agent acts as **orchestrator**. Start (or resume) with:

```
/loop continue the autonomous build per CLAUDE.md
```

The loop is **paused per phase**: after a phase's tasks are all done and the full
gate (incl. e2e) is green, the orchestrator **stops and asks the human to review
and merge** `impl/autonomous-build` → `main` before the next phase.

The build work happens on branch **`impl/autonomous-build`**. `main` only
advances by the human merging at phase boundaries. No git remote is configured;
everything is local.

---

## Orchestrator loop (each tick)

1. **Resume check.** If a task is marked `in-progress` in `TASKS.md`, recover it
   first (see *Resume contract* below) before picking new work.
2. **Pick task.** From `TASKS.md`, select the first `todo` task in the current
   phase whose dependencies are `done` and that is not `blocked`. Mark it
   `in-progress`.
3. **Phase boundary.** If no actionable task remains in the current phase:
   run the **full gate** (`scripts/gate-full.sh`). If green → **STOP** and tell
   the human to review/merge this phase. Do not start the next phase yourself.
4. **Implement.** Spawn the **`implementer`** subagent (Opus) with the task spec
   and the relevant `PLAN.md` sections. It writes code **and** tests.
5. **Fast gate.** Run `scripts/gate.sh` (lint + prettier + typecheck + unit). If
   red, hand the failures back to the implementer (counts as a review round).
6. **Review.** Spawn the **`reviewer`** subagent (Sonnet) with the task spec and
   the diff (`git diff` against the last commit). It returns **APPROVE** or a
   list of findings.
7. **Iterate.** On findings or a red gate, send them back to the implementer.
   Allow **up to 3 rounds** total. If still not approved → mark the task
   `blocked` with the reviewer's notes, and continue with other tasks.
8. **Commit.** On APPROVE **and** green fast gate: commit (see *Commit format*),
   mark the task `done` in `TASKS.md` (commit that too).
9. **Reschedule** the loop and repeat.

The orchestrator never writes feature code itself — it only edits `TASKS.md`,
runs the gate/git, and delegates to the two subagents.

---

## Resume contract (continuable across token-out / API error)

State lives **on disk and in git**, never only in context, so any fresh session
can resume:

- `TASKS.md` is the single source of truth for progress.
- On startup, find any `in-progress` task and run `scripts/gate.sh` on the
  working tree:
  - **Gate green** → hand to the reviewer, then commit (resume at step 6).
  - **Gate red / partial** → hand the current working tree to the implementer to
    *finish* the task from where it stopped (do **not** discard partial work).
- Never leave a task half-done without an `in-progress` marker. Update the marker
  before spawning a subagent so a crash is always recoverable.

---

## Gates

- **Fast gate** (`scripts/gate.sh`, every task): ESLint, Prettier check, type
  check (`svelte-check` / `tsc`), Vitest unit tests. Must be green to commit.
- **Full gate** (`scripts/gate-full.sh`, phase boundary): fast gate **+**
  Playwright e2e. Must be green before the human merge pause.
- Before the project is scaffolded (Phase 1), the gate scripts no-op gracefully
  (no `package.json` yet). Once scaffolded, every gate step must be wired into
  `package.json` scripts.

## Commit format

- One commit per completed task. Conventional commits, referencing the task id:

  ```
  <type>(<scope>): <summary>  [<task-id>]

  <what/why, 1–3 lines>

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Commit only when fast gate is green **and** the reviewer approved.
- Also commit the `TASKS.md` status change with (or immediately after) the task.

## Blocked / external-input tasks

Some tasks need real secrets or assets only the human can supply (Mailgun/Neon
credentials — PLAN #24; PWA icons/theme — PLAN #25). For these:

- Build against the **local-dev story**: local Postgres, **magic-link URL logged
  to the console** (no real email), placeholder PWA assets.
- Mark the credential/asset-dependent part `blocked` in `TASKS.md` with a clear
  `NEEDS-INPUT:` note, leave a `TODO`, and **continue** with other tasks.
- Never hard-code secrets. All config via env vars documented in `.env.example`.

---

## Conventions (apply to all implementation)

- **Package manager: pnpm** for everything.
- **shadcn-svelte components via its CLI only** — never hand-author them
  (`pnpm dlx shadcn-svelte@latest add <name>`).
- Business logic in `lib/server/` (testable); shared Zod schemas in
  `lib/schemas/`; money math in `lib/money` (integer minor units, **no floats**).
- Server-first (SvelteKit `load` + form `actions`); progressive enhancement.
- Follow `PLAN.md` exactly for naming that it pins down (e.g. the deliberate
  `created_at` = editable real-world date vs `occurred_at` = immutable insert
  time — see §7.1).
- Mobile-first, fully responsive (PLAN §10, #28).
- Every mutation writes an append-only `audit_log` row in the **same DB
  transaction** (PLAN §12.1).
