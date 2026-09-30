# Issue tracker: GitHub

Issues live in this repo's GitHub Issues; use the `gh` CLI (it infers the repo
from the git remote). Use a heredoc for multi-line bodies.

**PRs as a request surface: no.** External PRs are not triaged.

## Wayfinding operations

The **map** is one issue labelled `wayfinder:map`; its tickets are GitHub
sub-issues labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).

- **Blocking** uses native issue dependencies:
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  The id is the numeric database id (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`),
  not the `#number`. `issue_dependencies_summary.blocked_by` counts open blockers.
- **Frontier**: the map's open sub-issues with no assignee and no open blocker;
  first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment the answer, close the issue, then add a one-line pointer
  to the map's Decisions-so-far.
