# Plan 001: Replace the stale scaffold README with a real project README

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 32f4f15..HEAD -- README.md`
> If `README.md` changed since this plan was written, compare the "Current
> state" excerpt below against the live file before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `32f4f15`, 2026-06-20

## Why this matters

`README.md` is still the untouched SvelteKit scaffold template. It is titled
`# sv`, tells the reader to run `npx sv create` and `npm install`, and never
mentions that this repo is "PayWithMe", what it does, or where the real docs
live. The project uses **pnpm**, not npm — so a new contributor or AI agent who
follows the README will use the wrong package manager (creating a conflicting
`package-lock.json`) and will never discover the authoritative spec (`PLAN.md`),
the conventions (`CLAUDE.md`), or the local-dev setup (`docs/local-dev.md`).
A correct README is the single highest-leverage doc fix here.

## Current state

- `README.md` (the only file this plan touches) — currently the generic SvelteKit
  CLI scaffold output. Its first lines are:

  ```md
  # sv

  Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

  ## Creating a project

  If you're seeing this, you've probably already done this step. Congrats!
  ```

  It then documents `npx sv create`, `npm install`, `npm run dev`, and
  `npm run build` — none of which match this repo.

- Facts to put in the new README (verified during recon, do not invent others):
  - **What it is**: a shared-expense / bill-splitting PWA. Groups of people track
    spending and transfers, split bills (equal / by amount / by share / itemized
    with charges & discounts), handle multi-currency with manual FX, and settle up
    with minimized suggested transfers. Auth is passwordless (magic link +
    passkey). (Source: `PLAN.md` — the authoritative product spec; `CLAUDE.md`.)
  - **Package manager**: pnpm (`CLAUDE.md`: "Package manager: pnpm for everything";
    `package.json` declares `"packageManager": "pnpm@11.0.9"`).
  - **Stack**: SvelteKit 2 + Svelte 5 (runes), Tailwind 4, shadcn-svelte,
    Drizzle ORM + Postgres, better-auth, Zod. Deployed to Vercel (Node runtime).
  - **Real docs to link** (these files exist — verify with the command in Step 1):
    - `PLAN.md` — authoritative product spec.
    - `CLAUDE.md` — project conventions for contributors/agents.
    - `docs/local-dev.md` — local Postgres + dev setup.
    - `docs/autonomous-build.md` — how the build loop works.
  - **Scripts that exist** (from `package.json`, verified): `pnpm dev`,
    `pnpm build`, `pnpm preview`, `pnpm check` (typecheck), `pnpm lint`,
    `pnpm format`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`,
    `pnpm db:migrate`, `pnpm db:studio`.
  - **Env**: copy `.env.example` to `.env` (the example documents every variable;
    `.env` is gitignored). Do NOT enumerate secret values.

## Commands you will need

| Purpose                                      | Command                                                                                               | Expected on success           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| Confirm linked docs exist                    | `ls README.md PLAN.md CLAUDE.md docs/local-dev.md docs/autonomous-build.md .env.example package.json` | all listed, no "No such file" |
| Format check (README is covered by Prettier) | `pnpm format:check`                                                                                   | exit 0                        |
| Read scripts to cite accurately              | `cat package.json`                                                                                    | shows the `scripts` block     |

## Scope

**In scope** (the only file you may modify):

- `README.md`

**Out of scope** (do NOT touch):

- `PLAN.md`, `CLAUDE.md`, `docs/**`, `.env.example` — they are already correct;
  only link to them.
- Any code or config file. This is a docs-only change.

## Git workflow

- Branch: `advisor/001-readme-rewrite` (create from the current branch).
- One commit. Message style is Conventional Commits (see `git log`, e.g.
  `feat(a11y): keyboard + screen-reader accessibility pass`). Use:
  `docs: replace scaffold README with project README`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the linked docs and scripts exist

Run the "Confirm linked docs exist" command. Every path must resolve. Then
`cat package.json` and confirm the script names listed in "Current state" match
the `scripts` block (names can drift — cite only the ones that are actually
present).

**Verify**: `ls README.md PLAN.md CLAUDE.md docs/local-dev.md docs/autonomous-build.md .env.example package.json` → all paths printed, no error. If any linked doc is missing, drop that link from the README (do not invent a path).

### Step 2: Overwrite `README.md`

Replace the entire file with a concise project README (target: 30–50 lines).
Match the structure below; adjust wording to be accurate, do not pad. Use only
facts from "Current state". Do not include any secret values.

Required sections:

1. **Title + one-line description** — e.g. `# PayWithMe` followed by a one-sentence
   description of the bill-splitting PWA.
2. **What it does** — 3–6 bullet points drawn from the "What it is" facts
   (groups, split modes, multi-currency manual FX, settle-up, passwordless auth, PWA).
3. **Tech stack** — one short line listing the stack from "Current state".
4. **Getting started** — a fenced `sh` block:
   ```sh
   pnpm install
   cp .env.example .env   # then fill in the values documented in .env.example
   pnpm db:migrate        # apply migrations to your local Postgres (see docs/local-dev.md)
   pnpm dev               # http://localhost:5173
   ```
   Add one sentence pointing at `docs/local-dev.md` for the local Postgres setup
   (the repo has a `docker-compose.yml` for this — mention it).
5. **Common scripts** — a short table or list of the verified scripts
   (`pnpm check`, `pnpm lint`, `pnpm format`, `pnpm test:unit`,
   `pnpm test:integration`, `pnpm test:e2e`).
6. **Docs** — a bullet list linking the authoritative docs with one-line
   descriptions: `PLAN.md` (spec), `CLAUDE.md` (conventions),
   `docs/local-dev.md` (local setup), `docs/autonomous-build.md` (build loop).

Do NOT mention `npx sv create`, `npm`, or any scaffolding step. Do NOT claim
features not in `PLAN.md`.

**Verify**: `grep -c "npm " README.md` → `0` (no bare `npm ` commands), and
`grep -c "pnpm" README.md` → `≥ 4`.

### Step 3: Confirm formatting and links

**Verify**:

- `pnpm format:check` → exit 0 (Prettier is happy with the new README; if it
  fails on README only, run `pnpm format` and re-check).
- `grep -E "PLAN.md|CLAUDE.md|docs/local-dev.md" README.md` → at least these three
  links present.

## Test plan

This is a docs-only change; there are no unit tests. Verification is the three
`grep`/`pnpm format:check` checks above. No test files are added or modified.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "npm " README.md` returns `0`
- [ ] `grep -c "pnpm" README.md` returns `≥ 4`
- [ ] `grep -q "^# " README.md && ! grep -q "^# sv$" README.md` (title is not `# sv`)
- [ ] `grep -E "PLAN.md|CLAUDE.md|docs/local-dev.md" README.md` finds all three
- [ ] `pnpm format:check` exits 0
- [ ] `git status --porcelain` shows only `README.md` modified
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The current `README.md` does NOT start with `# sv` / the scaffold text (the repo
  has drifted — someone may have already rewritten it; don't clobber real content).
- A linked doc named in "Current state" does not exist and you're unsure what to
  link instead.
- `pnpm format:check` fails for reasons unrelated to `README.md`.

## Maintenance notes

- Keep the script list in sync with `package.json` if scripts are renamed.
- If `docs/` is reorganized, update the links here.
- A reviewer should check that no feature is claimed that `PLAN.md` doesn't
  describe, and that pnpm (not npm) is used throughout.
