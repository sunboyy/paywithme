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
- [ ] 1.12 Playwright config (incl. virtual authenticator) + `test:e2e` script @todo deps:1.1
- [ ] 1.13 CI workflow (GitHub Actions): lint + typecheck + unit @todo deps:1.10,1.11
- [ ] 1.14 Wire `package.json` scripts so `scripts/gate.sh`/`gate-full.sh` have teeth (`lint`,`format:check`,`check`,`test:unit`,`test:e2e`) @todo deps:1.10,1.11,1.12

## Phase 2 — Auth (magic link + passkey) (PLAN §5, §11.1, §14.2)

- [ ] 2.1 better-auth server config: `drizzleAdapter` + `magicLink` + `passkey` plugins (no password/social) @todo deps:1.8
- [ ] 2.2 `/api/auth/[...all]/+server.ts` handler mount @todo deps:2.1
- [ ] 2.3 `lib/server` email helper (Mailgun HTTP API) with **local console-log fallback** — PLAN #24. NEEDS-INPUT: real MAILGUN\_\* for live send (build local path now) @todo deps:2.1
- [ ] 2.4 `hooks.server.ts`: resolve session → `locals.user`/`locals.session` @todo deps:2.1
- [ ] 2.5 `/register` (email + display name) → magic link @todo deps:2.2,2.3
- [ ] 2.6 Magic-link landing + capture display name to `user.name` after first verify — PLAN #26 @todo deps:2.5
- [ ] 2.7 `/login` (passkey primary + email-link fallback) @todo deps:2.2
- [ ] 2.8 `/onboarding/passkey` post-first-login nudge (skippable) @todo deps:2.6
- [ ] 2.9 Passkey enrolment (`addPasskey`) + `/settings` manage passkeys (multiple devices) @todo deps:2.7
- [ ] 2.10 Logout @todo deps:2.4
- [ ] 2.11 Rate-limit magic-link requests; strict rpID/origin/trustedOrigins per env — PLAN §12 @todo deps:2.5
- [ ] 2.12 Auth e2e: magic-link register/login (intercept link), passkey enrol+login (virtual authenticator), recovery path — PLAN §13 @todo deps:2.9

## Phase 3 — Groups & members (PLAN §6, §14.3)

- [ ] 3.1 Schema: `groups`, `members`, `invites` (+ indexes, unique member-per-user-per-group) @todo deps:1.8
- [ ] 3.2 Currency constant/table seed: 29 fiat currencies w/ exponent+symbol — PLAN §7.5.1/#19 @todo deps:3.1
- [ ] 3.3 Group CRUD: create/rename/soft-delete; settlement currency editable only pre-first-tx then locked — PLAN §6.4 @todo deps:3.1,3.2
- [ ] 3.4 `/groups` dashboard + `/groups/new` @todo deps:3.3
- [ ] 3.5 `/groups/[id]/members`: manage members + soft-deactivate — PLAN §6.3 @todo deps:3.3
- [ ] 3.6 Invite links: create/copy/revoke (reusable, 7-day expiry, multiple active) — PLAN §6.2 @todo deps:3.5
- [ ] 3.7 `/invite/[token]` accept flow (login required; assign/create member; one-member-per-user-per-group) @todo deps:3.6,2.7
- [ ] 3.8 Group-access enforcement in `lib/server` (membership-based) — PLAN §12 @todo deps:3.3
- [ ] 3.9 Integration tests: invite/accept, access control, member lifecycle @todo deps:3.7,3.8

## Phase 4 — Transactions (PLAN §7, §14.4)

- [ ] 4.1 `lib/money` currency-aware helper (parse/format/largest-remainder, ascending member_id tie-break) + unit tests — PLAN §7.5/§7.2 @todo deps:3.2
- [ ] 4.2 Schema: `transactions`, `transaction_payers`, `transaction_shares`, `transaction_items`, `transaction_item_shares`, `transaction_charges`, `audit_log` (+ indexes) — PLAN §9 @todo deps:3.1
- [ ] 4.3 Categories seed (spending + transfer sets, lucide icons) — PLAN §7.3 @todo deps:4.2
- [ ] 4.4 Shared Zod schemas + validation rules — PLAN §7.4 @todo deps:4.2
- [ ] 4.5 Split resolution equal/amount/share (+ rounding/tie-break) + unit tests — PLAN §7.2 @todo deps:4.1,4.4
- [ ] 4.6 `lib/server` audit-log write helper (same DB transaction) — PLAN §12.1 (wire into all mutations below) @todo deps:4.2
- [ ] 4.7 Transaction add/edit/list UI: spending & transfer, type toggle, category picker @todo deps:4.5,4.3,4.6
- [ ] 4.8 Itemized splitting: items + per-item split + resolution + tests — PLAN §7.2.1 @todo deps:4.7
- [ ] 4.9 Charges/discounts: service/VAT/discount (mode/base/sort_order), proportional allocation, live breakdown UI + tests — PLAN §7.2.2-3 @todo deps:4.8
- [ ] 4.10 Multi-currency + manual FX: currency picker, rate/settlement-total entry, convert-then-distribute into settlement shares + tests — PLAN §7.6 @todo deps:4.9
- [ ] 4.11 Transaction view/edit page; soft-delete + restore (audited) @todo deps:4.7

## Phase 5 — Debts & settlement (PLAN §8, §14.5)

- [ ] 5.1 Net balance per member (settlement currency) + unit tests — PLAN §8.1 @todo deps:4.10
- [ ] 5.2 "Who should pay" ordering — PLAN §8.2 @todo deps:5.1
- [ ] 5.3 Simplified settlement suggestions (greedy minimize-transfers) + unit tests (edge cases) — PLAN §8.3 @todo deps:5.1
- [ ] 5.4 `/groups/[id]/settle` UI + settle-via-transfer prefill — PLAN §8.4 @todo deps:5.3

## Phase 6 — Audit log UI (PLAN §12.1, §14.6)

- [ ] 6.1 Extend audit writes to member/invite/group actions (helper from 4.6) @todo deps:4.6,3.6,3.3
- [ ] 6.2 `/groups/[id]/activity` feed (newest first, optional filters) @todo deps:6.1
- [ ] 6.3 Per-transaction history on the detail page @todo deps:6.1,4.11
- [ ] 6.4 Audit integration tests (one entry per mutation; survives soft-delete) @todo deps:6.2

## Phase 7 — PWA (PLAN §11, §14.7)

- [ ] 7.1 `@vite-pwa/sveltekit`: manifest (name/short_name/display/start_url, placeholder icons+colors) @todo deps:1.9
- [ ] 7.2 Service worker: precache static only; NetworkOnly for navigations + `/api/**` (never cache auth) — PLAN §11.1 @todo deps:7.1
- [ ] 7.3 Offline shell + offline state UI (disable writes) @todo deps:7.2
- [ ] 7.4 Install prompt handling @todo deps:7.1
- [ ] 7.5 SW update prompt-to-reload — PLAN §11.1 @todo deps:7.2
- [ ] 7.6 Real PWA icons (192/512 + maskable) + theme/background colors — PLAN #25. NEEDS-INPUT: user-supplied assets @blocked deps:7.1

## Phase 8 — Polish (PLAN §10, §13, §14.8)

- [ ] 8.1 Empty states across screens @todo deps:5.4,6.2
- [ ] 8.2 Mobile UX pass (one-handed, bottom-reachable actions) — PLAN #28 @todo deps:8.1
- [ ] 8.3 Accessibility pass @todo deps:8.1
- [ ] 8.4 Full e2e suite: create group → add tx → settle → balances zero; activity newest-first — PLAN §13 @todo deps:5.4,6.2
- [ ] 8.5 Performance pass @todo deps:8.4

---

## Blocked / NEEDS-INPUT register

- **2.3** — live Mailgun send (`MAILGUN_API_KEY`/`MAILGUN_DOMAIN`/`MAILGUN_BASE_URL`/`EMAIL_FROM`). Local console-log path built meanwhile.
- **7.6** — real PWA icons + theme/background colors. Placeholders used meanwhile.
- **Deploy** (not a numbered task) — real Neon pooled+direct URLs. Local Postgres used for the whole build.
