// Vitest `setupFiles` for the `integration` project (task 3.9).
//
// Runs ONCE per integration test module, BEFORE that module (and therefore the
// app's `$lib/server/db` client) is imported. Its single job is to make
// `DATABASE_URL` available on `process.env` so the lazy `db` proxy
// (`src/lib/server/db/index.ts`, which reads `env.DATABASE_URL` via
// `$env/dynamic/private` → `process.env`) can connect to the LOCAL Postgres.
//
// We mirror `playwright.config.ts`: default to the COMMITTED local-dev URL (not a
// secret) when the env var is unset, so `pnpm test:integration` runs without any
// hand-set environment. A real `DATABASE_URL` in the environment is respected.
//
// We do NOT assert connectivity here — that is done lazily by the per-suite
// `describeIntegration` guard in `./helpers.ts`, which downgrades the whole suite
// to `describe.skip` (with a clear message) when Postgres is unreachable. Keeping
// the skip decision out of the setup file means `pnpm test:integration` is always
// safe to run, with or without a database.

// The committed local-dev Postgres URL (see `.env` / `playwright.config.ts`).
// Not a secret — it points at the throwaway local `paywithme-postgres` container.
const LOCAL_DEV_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/paywithme';

process.env.DATABASE_URL ??= LOCAL_DEV_DATABASE_URL;
// The app client only uses the pooled `DATABASE_URL`; keep the unpooled one in
// sync for any tooling that reads it (harmless when already set).
process.env.DATABASE_URL_UNPOOLED ??= process.env.DATABASE_URL;
