# Project guide

This repo is built autonomously from [`PLAN.md`](./PLAN.md) (the product spec)
by the loop in [`docs/autonomous-build.md`](./docs/autonomous-build.md). Task
status lives in GitHub Issues (`sunboyy/paywithme`).

## Conventions

- pnpm for everything.
- Add shadcn-svelte components only via `pnpm dlx shadcn-svelte@latest add <name>`.
- Business logic in `lib/server/`, shared Zod schemas in `lib/schemas/`, money
  math in `lib/money` (integer minor units, no floats).
- Server-first: SvelteKit `load` + form `actions`, progressively enhanced.
- Use the names `PLAN.md` pins down, e.g. `created_at` (editable real-world date)
  vs `occurred_at` (immutable insert time), §7.1.
- Mobile-first and fully responsive.
- Every mutation writes an `audit_log` row in the same DB transaction.

## Agent skills

- Issue tracker: `docs/agents/issue-tracker.md`
- Triage labels: `docs/agents/triage-labels.md`
- Domain docs (`CONTEXT.md`, `docs/adr/`): `docs/agents/domain.md`
