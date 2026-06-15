# Local development

How to get a local Postgres running and prove the migration pipeline works.

The app talks to Postgres in every environment. Locally we run a containerized
Postgres that matches the connection URL already baked into `.env.example`:

```
postgresql://postgres:postgres@localhost:5432/paywithme
```

Production uses Neon (see [`PLAN.md`](../PLAN.md) §3/§4); the steps below are
dev-only.

## 1. Start Postgres (primary path: Docker Compose)

The canonical setup is [`docker-compose.yml`](../docker-compose.yml): a pinned
`postgres:16` service with user/password/db = `postgres`/`postgres`/`paywithme`,
published on `localhost:5432`, with a healthcheck and a named volume so data
survives restarts.

```sh
docker compose up -d          # start in the background
docker compose ps             # wait until STATUS shows "healthy"
```

Stop it when you're done:

```sh
docker compose down           # stop; data persists in the named volume
docker compose down -v        # stop AND delete the data volume (fresh start)
```

## 2. Create your local `.env`

`.env` is git-ignored. Copy the committed template:

```sh
cp .env.example .env
```

The default `DATABASE_URL` / `DATABASE_URL_UNPOOLED` already point at the local
Postgres above, so for the database you don't need to change anything. (Auth and
email vars are filled in by later phases.)

- `DATABASE_URL` — pooled URL the app uses at runtime (`src/lib/server/db`).
- `DATABASE_URL_UNPOOLED` — direct URL drizzle-kit uses for migrations
  (`drizzle.config.ts`). On a single local Postgres there is no pooler, so both
  URLs are identical.

## 3. Run the first migration

```sh
pnpm db:migrate
```

`db:migrate` (drizzle-kit migrate) connects using `DATABASE_URL_UNPOOLED`,
creates drizzle's `__drizzle_migrations` bookkeeping table on first run, and
applies any pending migration files in `drizzle/`. With the current empty schema
there are zero migrations to apply — a successful run proves the dev DB and the
migration path work end to end.

Related scripts:

- `pnpm db:generate` — generate a new SQL migration from changes to
  `src/lib/server/db/schema.ts` (writes into `drizzle/`). Schema tables arrive in
  later tasks, so today this produces nothing.
- `pnpm db:push` — sync the schema directly to the DB without a migration file.
  Handy for quick local iteration; against the empty schema it's a no-op that
  also confirms connectivity.
- `pnpm db:studio` — open Drizzle Studio to browse the local DB.

## Alternative: Homebrew Postgres (no Docker)

If you can't run Docker, a local Homebrew Postgres works too. Install and start
it, then create the role/database the URL expects:

```sh
brew install postgresql@16
brew services start postgresql@16

# Create the matching role + database (only needed once):
createuser -s postgres 2>/dev/null || true
psql -d postgres -c "ALTER ROLE postgres WITH PASSWORD 'postgres';"
createdb -O postgres paywithme
```

After that the `.env.example` URL connects the same way, and `pnpm db:migrate`
works exactly as above.
