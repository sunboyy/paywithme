# Project guide

This repo is built **autonomously** from [`PLAN.md`](./PLAN.md) by an
implement → review → test → commit loop.

- **What to build:** [`PLAN.md`](./PLAN.md) — authoritative product spec.
- **How the build runs:** [`docs/autonomous-build.md`](./docs/autonomous-build.md)
  — the orchestrator loop, gates, commit format, resume contract, and phase
  checkpoints. Follow it exactly.
- **Progress:** [`TASKS.md`](./TASKS.md) — single source of truth for task status.

Run (or resume) the build with:

```
/loop continue the autonomous build per docs/autonomous-build.md
```

---

## Project conventions

> Build-specific rules every agent must follow. (The build _workflow_ lives in
> `docs/autonomous-build.md` and is project-agnostic; this section is the only
> app-specific part.)

- **Package manager: pnpm** for everything.
- **shadcn-svelte components via its CLI only** — never hand-author them
  (`pnpm dlx shadcn-svelte@latest add <name>`).
- Business logic in `lib/server/` (testable); shared Zod schemas in
  `lib/schemas/`; money math in `lib/money` (integer minor units, **no floats**).
- Server-first (SvelteKit `load` + form `actions`); progressive enhancement.
- Follow `PLAN.md` exactly for naming it pins down (e.g. the deliberate
  `created_at` = editable real-world date vs `occurred_at` = immutable insert
  time — see §7.1).
- Mobile-first, fully responsive (PLAN §10).
- Every mutation writes an append-only `audit_log` row in the **same DB
  transaction** (PLAN §12.1).
