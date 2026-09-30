# Autonomous build

How the app gets built hands-off from `PLAN.md`: an implement → review → gate →
commit loop driven by `/loop`, with the main agent as **orchestrator**.

```
/loop continue the autonomous build per docs/autonomous-build.md
```

| Piece        | Where                                                         |
| ------------ | ------------------------------------------------------------- |
| Implementer  | `.claude/agents/implementer.md` — code + tests                |
| Reviewer     | `.claude/agents/reviewer.md` — APPROVE / CHANGES              |
| Fast gate    | `scripts/gate.sh` — lint, format, typecheck, unit             |
| Full gate    | `scripts/gate-full.sh` — fast gate + e2e                      |
| Task tracker | GitHub Issues (`gh` commands: `docs/agents/issue-tracker.md`) |

## Tracker state

A **phase** is a map issue; each **task** is a sub-issue, ordered by the map and
linked by native `blocked_by` dependencies. The sub-issue body cites the `PLAN.md`
§s it implements. Issue state is the only status record:

| Status      | On GitHub                                                |
| ----------- | -------------------------------------------------------- |
| todo        | open, `ready-for-agent`, no assignee                     |
| in-progress | open, assigned (the assignee is the lock)                |
| in-review   | open, assigned, `status:in-review`                       |
| blocked     | open, `status:blocked` (± `needs-info`) + reason comment |
| done        | closed                                                   |

The **current map** is the earliest one with an open sub-issue. The **frontier**
is its open sub-issues with no assignee, no `status:blocked`, and
`blocked_by == 0`; take the first in map order. A blocked task stays open, so
its dependents stay off the frontier until it is closed.

## Each tick

1. **Resume.** If a sub-issue of the current map is open, assigned, and not
   `status:blocked`, finish it first: run `scripts/gate.sh` on the working tree.
   Green → go to review. Red → send the implementer to continue the existing
   tree; never discard partial work.
2. **Claim** the first frontier task: `gh issue edit <n> --add-assignee @me`.
   Only one task is claimed at a time.
3. **Phase end.** If the frontier is empty, run `scripts/gate-full.sh`. When green,
   stop and report to the human: fully done or done-with-blocks (list each blocked
   task and its reason) and what was committed. Don't start the next map.
4. **Implement.** Spawn `implementer` with the sub-issue body and the text of the
   `PLAN.md` sections it cites (sliced at their headers, not the whole file). The
   implementer runs the fast gate and reports the result; trust it.
5. **Review.** Add `status:in-review`, stage everything (`git add -A`) and spawn
   `reviewer` with the sub-issue body, the same `PLAN.md` slice, and
   `git diff --staged`.
6. **Iterate.** On findings or a red gate report, remove `status:in-review` and
   send them back to the implementer. Gate fixes and review rounds share a budget
   of 3. When it runs out, add `status:blocked`, comment the last findings or gate
   output, and move on.
7. **Commit & close.** On APPROVE, run `scripts/gate.sh` once. If green, commit and
   `gh issue close <n>` (closing unblocks dependents; don't rely on `Closes #n`).
   If red, treat it as a round in step 6.
8. Reschedule the loop.

## Commit format

One commit per task:

```
<type>(<scope>): <summary> (#<issue>)

<what/why, 1–3 lines>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## Human inputs

When a task needs a secret or asset only the human can supply, build the
local-dev path, mark the task `status:blocked` + `needs-info` with a
`NEEDS-INPUT:` comment naming what is needed, and continue. Secrets go in `.env`
and are documented in `.env.example`.

## Rules

- The orchestrator writes no feature code; it only manages issues, runs gates,
  commits, and delegates.
- Only the orchestrator commits or changes issue status.
- Never commit on a red gate. Never push or merge; integration is the human's
  job at each phase end.
