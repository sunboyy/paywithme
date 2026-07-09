# TASKS — autonomous build

Single source of truth for build progress. Only the **orchestrator** edits this.
This file is **project-specific** (regenerate it per app from that app's
`PLAN.md`); the harness around it is reusable. Decomposed from `PLAN.md` §14.
Work top-to-bottom within a phase; respect `deps`.

**Status tags:** `@todo` `@in-progress` `@in-review` `@done` `@blocked`
A `[ ]`/`[x]` checkbox mirrors done-ness for quick scanning.
`NEEDS-INPUT:` marks a human-supplied dependency (PLAN #24 / #25).

> The loop **pauses after each phase** (full gate green) for human review + merge
> of `impl/autonomous-build` → `main`. Do not start the next phase unprompted.

---

## Phase 0 — Harness @done

- [x] 0.1 Orchestration harness (agents, TASKS.md, CLAUDE.md, gate scripts, docs, branch) @done

## Phase 1 — Foundation (PLAN §3, §14.1)

- [x] 1.1 Scaffold SvelteKit + TS via pnpm; add `@sveltejs/adapter-vercel` (Node runtime) @done
- [x] 1.2 Tailwind CSS setup @done deps:1.1
- [x] 1.3 Init shadcn-svelte via CLI; verify `@lucide/svelte` present @done deps:1.2
- [x] 1.4 Add base shadcn components via CLI (button, card, dialog, sheet/drawer, form, input, select, tabs, avatar, badge, table, sonner/toast, separator) @done deps:1.3
- [x] 1.5 Drizzle ORM + drizzle-kit config; `pg` driver; pooled (app) vs direct (migrations) URL wiring @done deps:1.1
- [x] 1.6 `.env.example` documenting every env var (Neon pooled+direct, MAILGUN\_\*, EMAIL_FROM, rpID/origin/trustedOrigins) — PLAN #24 @done deps:1.5
- [x] 1.7 Local Postgres dev setup (docker-compose or doc) + first migration runs @done deps:1.5
- [x] 1.8 Install better-auth + Drizzle adapter; generate/migrate auth tables (user/session/account/verification/passkey) @done deps:1.7
- [x] 1.9 Base app shell + root layout (mobile-first, responsive) — PLAN §10/#28 @done deps:1.4
- [x] 1.10 ESLint + Prettier config; `lint` + `format:check` scripts @done deps:1.1
- [x] 1.11 Vitest config + `test:unit` script + sample test @done deps:1.1
- [x] 1.12 Playwright config (incl. virtual authenticator) + `test:e2e` script @done deps:1.1
- [x] 1.13 CI workflow (GitHub Actions): lint + typecheck + unit @done deps:1.10,1.11
- [x] 1.14 Wire `package.json` scripts so `scripts/gate.sh`/`gate-full.sh` have teeth (`lint`,`format:check`,`check`,`test:unit`,`test:e2e`) @done deps:1.10,1.11,1.12

## Phase 2 — Auth (magic link + passkey) (PLAN §5, §11.1, §14.2)

- [x] 2.1 better-auth server config: `drizzleAdapter` + `magicLink` + `passkey` plugins (no password/social) @done deps:1.8
- [x] 2.2 `/api/auth/[...all]/+server.ts` handler mount @done deps:2.1
- [x] 2.3 `lib/server` email helper (Mailgun HTTP API) with **local console-log fallback** — PLAN #24. Live Mailgun send verified end-to-end (domain `mg.sunboyy.com`, real creds in `.env`) on 2026-06-16. @done deps:2.1
- [x] 2.4 `hooks.server.ts`: resolve session → `locals.user`/`locals.session` @done deps:2.1
- [x] 2.5 `/register` (email + display name) → magic link @done deps:2.2,2.3
- [x] 2.6 Magic-link landing + capture display name to `user.name` after first verify — PLAN #26 @done deps:2.5
- [x] 2.7 `/login` (passkey primary + email-link fallback) @done deps:2.2
- [x] 2.8 `/onboarding/passkey` post-first-login nudge (skippable) @done deps:2.6
- [x] 2.9 Passkey enrolment (`addPasskey`) + `/settings` manage passkeys (multiple devices) @done deps:2.7
- [x] 2.10 Logout @done deps:2.4
- [x] 2.11 Rate-limit magic-link requests; strict rpID/origin/trustedOrigins per env — PLAN §12 @done deps:2.5
- [x] 2.12 Auth e2e: magic-link register/login (intercept link), passkey enrol+login (virtual authenticator), recovery path — PLAN §13 @done deps:2.9

## Phase 3 — Groups & members (PLAN §6, §14.3)

- [x] 3.1 Schema: `groups`, `members`, `invites` (+ indexes, unique member-per-user-per-group) @done deps:1.8
- [x] 3.2 Currency constant/table seed: 29 fiat currencies w/ exponent+symbol — PLAN §7.5.1/#19 @done deps:3.1
- [x] 3.3 Group CRUD: create/rename/soft-delete; settlement currency editable only pre-first-tx then locked — PLAN §6.4 @done deps:3.1,3.2
- [x] 3.4 `/groups` dashboard + `/groups/new` @done deps:3.3
- [x] 3.5 `/groups/[id]/members`: manage members + soft-deactivate — PLAN §6.3 @done deps:3.3
- [x] 3.6 Invite links: create/copy/revoke (reusable, 7-day expiry, multiple active) — PLAN §6.2 @done deps:3.5
- [x] 3.7 `/invite/[token]` accept flow (login required; assign/create member; one-member-per-user-per-group) @done deps:3.6,2.7
- [x] 3.8 Group-access enforcement in `lib/server` (membership-based) — PLAN §12 @done deps:3.3
- [x] 3.9 Integration tests: invite/accept, access control, member lifecycle @done deps:3.7,3.8

## Phase 4 — Transactions (PLAN §7, §14.4)

- [x] 4.1 `lib/money` currency-aware helper (parse/format/largest-remainder, ascending member_id tie-break) + unit tests — PLAN §7.5/§7.2 @done deps:3.2
- [x] 4.2 Schema: `transactions`, `transaction_payers`, `transaction_shares`, `transaction_items`, `transaction_item_shares`, `transaction_charges`, `audit_log` (+ indexes) — PLAN §9 @done deps:3.1
- [x] 4.3 Categories seed (spending + transfer sets, lucide icons) — PLAN §7.3 @done deps:4.2
- [x] 4.4 Shared Zod schemas + validation rules — PLAN §7.4 @done deps:4.2
- [x] 4.5 Split resolution equal/amount/share (+ rounding/tie-break) + unit tests — PLAN §7.2 @done deps:4.1,4.4
- [x] 4.6 `lib/server` audit-log write helper (same DB transaction) — PLAN §12.1 (wire into all mutations below) @done deps:4.2
- [x] 4.7 Transaction add/edit/list UI: spending & transfer, type toggle, category picker @done deps:4.5,4.3,4.6
- [x] 4.8 Itemized splitting: items + per-item split + resolution + tests — PLAN §7.2.1 @done deps:4.7
- [x] 4.9 Charges/discounts: service/VAT/discount (mode/base/sort_order), proportional allocation, live breakdown UI + tests — PLAN §7.2.2-3 @done deps:4.8
- [x] 4.10 Multi-currency + manual FX: currency picker, rate/settlement-total entry, convert-then-distribute into settlement shares + tests — PLAN §7.6 @done deps:4.9
- [x] 4.11 Transaction view/edit page; soft-delete + restore (audited) @done deps:4.7

## Phase 5 — Debts & settlement (PLAN §8, §14.5)

- [x] 5.1 Net balance per member (settlement currency) + unit tests — PLAN §8.1 @done deps:4.10
- [x] 5.2 "Who should pay" ordering — PLAN §8.2 @done deps:5.1
- [x] 5.3 Simplified settlement suggestions (greedy minimize-transfers) + unit tests (edge cases) — PLAN §8.3 @done deps:5.1
- [x] 5.4 `/groups/[id]/settle` UI + settle-via-transfer prefill — PLAN §8.4 @done deps:5.3

## Phase 6 — Audit log UI (PLAN §12.1, §14.6)

- [x] 6.1 Extend audit writes to member/invite/group actions (helper from 4.6) @done deps:4.6,3.6,3.3
- [x] 6.2 `/groups/[id]/activity` feed (newest first, optional filters) @done deps:6.1
- [x] 6.3 Per-transaction history on the detail page @done deps:6.1,4.11
- [x] 6.4 Audit integration tests (one entry per mutation; survives soft-delete) @done deps:6.2

## Phase 7 — PWA (PLAN §11, §14.7)

- [x] 7.1 `@vite-pwa/sveltekit`: manifest (name/short_name/display/start_url, placeholder icons+colors) @done deps:1.9
- [x] 7.2 Service worker: precache static only; NetworkOnly for navigations + `/api/**` (never cache auth) — PLAN §11.1 @done deps:7.1
- [x] 7.3 Offline shell + offline state UI (disable writes) @done deps:7.2
- [x] 7.4 Install prompt handling @done deps:7.1
- [x] 7.5 SW update prompt-to-reload — PLAN §11.1 @done deps:7.2
- [x] 7.6 Real PWA icons (192/512 + maskable) + theme/background colors — PLAN #25. Designed in-house (user authorized 2026-06-18: "design PWA icons as suitable for the app"). @done deps:7.1

## Phase 8 — Polish (PLAN §10, §13, §14.8)

- [x] 8.1 Empty states across screens @done deps:5.4,6.2
- [x] 8.2 Mobile UX pass (one-handed, bottom-reachable actions) — PLAN #28 @done deps:8.1
- [x] 8.3 Accessibility pass @done deps:8.1
- [x] 8.4 Full e2e suite: create group → add tx → settle → balances zero; activity newest-first — PLAN §13 @done deps:5.4,6.2
- [x] 8.5 Performance pass @done deps:8.4

## Phase 9 — Public API for AI agents (PLAN §16)

> A versioned REST/JSON API under `/api/v1`, authenticated by API keys, as a thin
> HTTP surface over existing `lib/server` logic. Work top-to-bottom; `9.1`/`9.2`
> gate everything. The DTO layer (`9.5`) precedes the endpoints that return it.

- [ ] 9.1 Install `@better-auth/api-key@^1.6.18`; add `apiKey({...})` to `auth.ts` plugins **before** `sveltekitCookies`; `enableSessionForAPIKeys` off — PLAN §16.1 @todo deps:2.1
- [ ] 9.2 Hand-author `db/api-key-schema.ts` (`apikey` model, table `api_key`; `rateLimitTimeWindow`/`refillInterval` as `bigint`) + migration; `pwm_test_`/`pwm_live_` prefix policy — PLAN §16.1 @todo deps:9.1
- [ ] 9.3 `hooks.server.ts`: `sequence(resolveSession, apiV1Guard)` — for `/api/v1/*` skip cookie session, verify `Authorization: Bearer` via `verifyApiKey`, short-circuit generic 401, attach `locals.apiKey` — PLAN §16.3 @todo deps:9.2
- [ ] 9.4 Error envelope helper + `handleError` 500-normalization + catch-all `api/v1/[...unknown]/+server.ts` (404 envelope); scopes: `read`/`write` in `permissions` + shared `scope==='write'` write-guard (403); reuse `access.ts` for 404 conflation — PLAN §16.2/§16.5 @todo deps:9.3
- [ ] 9.5 `src/lib/server/api/v1/` DTO + mapper layer (drop `TransactionDetail.input`, `Group.deletedAt`); money-on-wire `{amount,currency}`; unit tests — PLAN §16.4 @todo deps:9.4
- [ ] 9.6 Extend internal `listTransactions` with keyset `after` cursor over `(createdAt DESC, occurredAt DESC, id)` + `from`/`to` date-range filter + tests — PLAN §16.4 @todo deps:4.11
- [ ] 9.7 Read endpoints: `GET /currencies`, `/groups`, `/groups/{gid}`, `/members`, `/balances`, `/transactions` (cursor+filters), `/transactions/{txid}` — PLAN §16.4 @todo deps:9.5,9.6
- [ ] 9.8 Write endpoints: `POST`/`PUT`/`DELETE`/restore transactions (body = full `TransactionInput` via `buildTransactionSchema`; `amountTotalSettlement` mismatch → 422) + `POST …/settle-up` Transfer façade — PLAN §16.4 @todo deps:9.7
- [ ] 9.9 Idempotency: hand-authored store table (key-scoped, 24h TTL, pending-first unique constraint), replay/409 semantics on POST creates; gate audit write on rows-affected > 0 for no-op delete/restore + tests — PLAN §16.6 @todo deps:9.8
- [ ] 9.10 Rate limiting: tier-1 plugin backstop (150/60s at creation) + tier-2 `api_key_class_rate_limit` table (read 100/60s, write 20/60s); 429 envelope + `Retry-After`; map plugin `RATE_LIMITED` → `rate_limited` + tests — PLAN §16.7 @todo deps:9.8
- [ ] 9.11 Audit provenance: write `{viaKey,keyName}` metadata + "(via API key '…')" summary suffix on API-driven mutations (zero schema change) — PLAN §16.2 @todo deps:9.8
- [ ] 9.12 Key-management UX under `/settings`: `/settings/api-keys/new` (server-first, scope radio-cards, expiry presets, masked one-time reveal), list w/ revoke via `ConfirmSubmit`; create/revoke audited — PLAN §16.8 @todo deps:9.2
- [ ] 9.13 Hand-written OpenAPI 3.1 spec `static/api/v1/openapi.yaml`(+`.json`); `/docs/api` prose route (quickstart + conventions); README "Public API" section + in-app doc links — PLAN §16.9 @todo deps:9.8
- [ ] 9.14 Integration tests (auth/scope/404-conflation/pagination/settle-up/audit) + contract test (live responses vs OpenAPI schemas; quickstart curl shape-check) — PLAN §16.10 @todo deps:9.9,9.10,9.11,9.13

---

## Blocked / NEEDS-INPUT register

- ~~**2.3** — live Mailgun send~~ ✅ RESOLVED 2026-06-16: real `MAILGUN_*` creds added to `.env`; live send verified end-to-end (HTTP 200 via `mg.sunboyy.com`, real POST path, no dev-fallback).
- ~~**7.6** — real PWA icons + theme/background colors~~ ✅ UNBLOCKED 2026-06-18: user authorized designing the icons in-house ("You can design PWA icons as suitable for the app"), so no external asset hand-off is needed; the app generates its own 192/512 + maskable icons and theme/background colors.
- **Deploy** (not a numbered task) — real Neon pooled+direct URLs. Local Postgres used for the whole build.
- ~~**2.11 prod hardening**~~ ✅ RESOLVED 2026-06-16: rate-limit storage is **Postgres-backed** (`rate_limit` table, migration `0001`, `storage: 'database'`) so counters are shared across serverless instances, AND `advanced.ipAddress.ipAddressHeaders = ['x-real-ip','x-forwarded-for']` pins Vercel's non-spoofable client IP for true per-IP buckets. Enforcement verified live (429 after the 5/60s magic-link cap; counts persist in `rate_limit`). _Residual (by design, v1):_ per-email throttling across many IPs is not done — better-auth keys on IP+path; mitigated by account-existence-agnostic responses + single-use short-lived tokens.
