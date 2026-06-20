# PayWithMe

A shared-expense / bill-splitting progressive web app for tracking spending and settling up within groups.

## What it does

- Create **groups** of people to track shared spending and transfers.
- Split bills by **equal**, **by amount**, **by share**, or **itemized** (with per-item charges & discounts).
- Handle **multi-currency** expenses with manual FX rates.
- **Settle up** with minimized suggested transfers.
- Sign in **passwordless** via magic link or passkey.
- Installable **PWA**, mobile-first and fully responsive.

## Tech stack

SvelteKit 2 + Svelte 5 (runes), Tailwind 4, shadcn-svelte, Drizzle ORM + Postgres, better-auth, and Zod. Deployed to Vercel (Node runtime).

## Getting started

```sh
pnpm install
cp .env.example .env   # then fill in the values documented in .env.example
pnpm db:migrate        # apply migrations to your local Postgres (see docs/local-dev.md)
pnpm dev               # http://localhost:5173
```

For local Postgres setup, see [`docs/local-dev.md`](./docs/local-dev.md) — the repo ships a `docker-compose.yml` to bring one up quickly.

## Common scripts

| Command                 | Purpose                |
| ----------------------- | ---------------------- |
| `pnpm check`            | Type-check the project |
| `pnpm lint`             | Lint with ESLint       |
| `pnpm format`           | Format with Prettier   |
| `pnpm test:unit`        | Run unit tests         |
| `pnpm test:integration` | Run integration tests  |
| `pnpm test:e2e`         | Run end-to-end tests   |

## Docs

- [`PLAN.md`](./PLAN.md) — authoritative product spec.
- [`CLAUDE.md`](./CLAUDE.md) — project conventions for contributors and agents.
- [`docs/local-dev.md`](./docs/local-dev.md) — local Postgres + dev setup.
- [`docs/autonomous-build.md`](./docs/autonomous-build.md) — how the build loop works.
