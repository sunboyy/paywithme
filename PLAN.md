# Pay with me — Implementation Plan

> **Pay with me** — a group expense app to record shared spending and transfers,
> then summarize and settle debts between members. SvelteKit SSR + PWA,
> shadcn-svelte styling, passwordless auth (email magic link + passkeys).
> (Inspired by Settle Up.)

**Status:** DRAFT — under revision. Nothing here is final.
**Last updated:** 2026-06-14

---

## 1. Scope & Goals

### In scope (v1)
- Passwordless auth: **email magic-link** registration/login, with **passkeys**
  (WebAuthn / FIDO2) enrolled after first login as the primary day-to-day login.
- Groups containing members; members optionally linked to real users.
- A user can belong to multiple groups.
- Record transactions of two types: **Spending** and **Transfer**.
- Per-transaction: title, category, payer(s), beneficiary/recipient(s), amount,
  and a split mode (equal / by amount / by share / **itemized**).
- Itemized splitting: break a spending into line items, each with its own amount
  and beneficiaries, plus per-spending **service charge, VAT, and discount**
  (entered fresh each time — no saved defaults).
- **Multi-currency with manual FX:** a group has one **settlement currency**;
  each transaction may be recorded in a different currency with a **manual
  exchange rate** entered per transaction (no FX API). Debt math is in the
  settlement currency. (See §7.6.)
- Debt summary per group: net balance per member, who owes whom.
- Settle a debt by recording a new Transfer transaction.
- **Audit log:** since anyone can create/edit/delete, record which user performed
  which action and when; viewable per group (newest first). (See §12.1.)
- Installable PWA with offline-friendly shell.

### Out of scope (v1) — confirmed
- Exporting (CSV/PDF).
- Real-time collaborative editing.
- Push notifications.
- Recurring transactions.
- Email/**password** authentication (passwordless by design — email magic link +
  passkeys only).
- Social login.
- Receipt photo upload (and OCR).

### Out of scope (v1) — also deferred (not yet discussed, candidates for later)
- **Automatic FX rates** (live rate API). Rates are **manual, per transaction**.
- Multi-currency *settlement* (a group settles in exactly one currency; only the
  per-transaction entry currency may differ).
- Reporting / charts / analytics.

---

## 2. Decisions (resolved) & Remaining Questions

### Resolved
1. **Money.** Stored as **integer minor units** to avoid float errors;
   precision is **per-currency** (see #13), formatted at that currency's decimal
   places in the UI. (See §7.5.)
2. **Split model.** Support four modes: **Equal**, **Split by amount** (exact),
   **Split by share** (weights), and **Itemized** (line items, each with its own
   amount + beneficiaries + per-item split). Schema stores a resolved per-member
   amount plus the chosen split mode + inputs. (See §7.2.)
3. **Multiple payers.** Store an explicit `amount_paid` per payer.
4. **Member ↔ user linking.** **Invite link** only. A member is assigned to the
   user **upon accepting the invite**. (See §6.2.)
5. **Permissions.** **No restrictions** in v1 — any group member can
   create/edit/delete any transaction and manage members.
6. **Account recovery.** **Via email magic link.** Losing all passkeys is not
   fatal — log in by magic link and re-enrol a passkey. Email access is the root
   of account access; no recovery codes. Multiple passkeys per account allowed.
   (See §5.6.)
7. **Offline.** **No offline creation.** PWA is installable + offline shell only;
   writes require connectivity.
8. **Auth library.** Use **better-auth** with its **magic-link plugin** (email,
   for registration / login / recovery) **+ passkey plugin** in its standard
   session-required mode (passkey enrolled after first login). No email/password,
   no social. The passkey-first / `resolveUser` mechanism is **no longer needed**.
   Email is sent via the **Mailgun HTTP API**. (See §3, §5.)
9. **Categories.** **Fixed system list** (seeded, not user-editable in v1).
   Separate sets for Spending vs Transfer, each with a **lucide** icon. The set
   is **general-purpose** (serves both travel and non-travel groups). (See §7.3.)
10. **Currency / FX.** Each group has one **settlement currency** (the base for
    all debt math). A transaction may be recorded in a **different currency** with
    a **manual exchange rate** entered on that transaction (no FX API). Amounts
    are converted to the settlement currency for balances/settlement. (See §6.1,
    §7.5, §7.6.)
11. **Settlement display.** Show **simplified suggestions** only (minimized
    transfers), not raw pairwise debts. (See §8.)
12. **Invite links.** **Reusable** links, **7-day expiry**, **multiple active
    links per group allowed**, with a **revocation UI**. (See §6.2.)
13. **Currency precision.** **Per-currency**, not a fixed 2dp. Each currency
    carries its minor-unit exponent (e.g. JPY/KRW/VND = 0, THB/USD = 2,
    KWD/BHD = 3); money math and rounding are currency-aware. (See §7.5.)
14. **Member removal.** **Soft-deactivate**, never hard-delete a member with
    activity. An inactive member stays in past transactions and balances but is
    hidden from new-transaction pickers. (See §6.3.)
15. **Group lifecycle.** A group's **settlement currency is editable only until
    its first transaction**, then **locked**. Groups are **soft-deleted** (hidden/
    recoverable), not hard-deleted. (See §6.4.)
16. **DB driver / runtime.** Vercel **Node** runtime with the **`pg`** driver
    over Neon's pooled URL; migrations use the non-pooled/direct URL. (See §3.)
17. **Manual FX.** Rate is **per transaction**, manual only, stored as
    settlement-currency units per 1 unit of the transaction currency. The
    settlement-converted total is computed once and stored canonically; balances
    never re-derive a rate. (See §7.6.)
18. **Audit log.** No per-action permissions, so an **append-only** audit log
    records actor + action + entity + server timestamp for every mutation (priority:
    transactions). Immutable; shown per group, newest first. (See §12.1.)

19. **Supported currencies.** Fixed seeded list of **29 fiat currencies** (top 30
    by market cap from fiatmarketcap.net, **minus BTC** — non-fiat, non-ISO
    minor units). Both settlement and entry currency must be from this list. (See
    §7.5.1.)
20. **Auth method (revised).** **Email magic link** is the baseline credential:
    registration collects **display name + email** and logs in via an emailed
    single-use link; the magic-link click **verifies the email**. A **passkey** is
    enrolled after first login and is the primary fast login thereafter. Email is
    required + unique. (Supersedes the earlier passkey-first draft.) (See §5.)
21. **Rounding tie-break.** Largest-remainder ties go to the **lower `member_id`**
    (ascending), so all split/charge/FX distribution is reproducible. (See §7.2.)
22. **Open invite accept.** Accepting any invite **requires a logged-in user**
    (no guest accept); an open link creates a new member named after the
    accepting user's display name. (See §6.2.)
23. **Transaction timestamps.** `created_at` = real-world date, **user-editable /
    backdatable** (sort + display key); `occurred_at` = immutable server insert
    time. (See §7.1.)
24. **Secrets / local dev.** A committed **`.env.example`** documents every env var
    (Neon pooled + direct URLs; `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`,
    `MAILGUN_BASE_URL`, `EMAIL_FROM`; `rpID` / `origin` / `trustedOrigins`). For
    **local dev**, use a **local Postgres** and **log the magic-link URL to the
    console** instead of sending email. The user supplies **real Neon + Mailgun
    credentials** at the point they're needed (email testing / deploy). (See §3, §5.)
25. **Branding / PWA assets.** The **user provides** the real PWA icons (192/512 +
    maskable) and theme/background colors. The manifest's icon/theme fields are
    filled last; everything else in §11 is built ahead of them. (See §11.)
26. **Display-name capture.** better-auth's magic-link plugin does not natively
    persist a name on signup, so the display name is collected on **`/register`**
    and written to **`user.name` immediately after the first magic-link
    verification** (onboarding step). (See §5.3.)
27. **FX integer math.** §7.6's conversion is implemented as a **single
    scaled-integer, round-half-up** expression (rate stored as 6-dp micro-units;
    `amount_settlement_minor = round_half_up(amount_txn_minor × rate_micros ×
    10^exp_settlement / (10^exp_txn × 10^6))`) — no intermediate float. (See §7.6.)
28. **Responsive, mobile-first UI.** The app is **primarily used on phones**, so
    every screen is **mobile-first and fully responsive**: built at a small-screen
    width first, then progressively enhanced for tablet/desktop (fluid layouts,
    Tailwind breakpoints, touch-friendly hit targets, bottom-reachable primary
    actions). All forms (transaction entry, itemized + charges, FX) and lists must
    remain usable one-handed on a phone; no layout requires a desktop viewport.
    (See §10.)

### Still to decide
- Nothing blocking — all major v1 decisions are resolved. Remaining items are
  fine-tuning during build (exact copy, final category names if you want tweaks,
  icon swaps, per-currency display symbol polish), plus the deferred user-supplied
  inputs noted in #24–#25 (real credentials and brand assets), provided when
  reached.

---

## 3. Tech Stack

| Concern            | Choice                                                            |
|--------------------|------------------------------------------------------------------|
| Framework          | **SvelteKit** (Svelte 5 runes), SSR via **`adapter-vercel`**      |
| Hosting            | **Vercel**                                                       |
| Package manager    | **pnpm**                                                          |
| Language           | TypeScript                                                        |
| UI / styling       | **shadcn-svelte** + Tailwind CSS                                  |
| Icons              | **lucide** (`@lucide/svelte`) — installed by shadcn-svelte init   |
| PWA                | `@vite-pwa/sveltekit` (Workbox service worker + manifest)         |
| Auth               | **better-auth** + **magic-link plugin** (email) + **passkey plugin** (passwordless) |
| Email              | **Mailgun HTTP API** (`mailgun.js`, or plain `fetch`) for magic links |
| Session            | Managed by better-auth (HTTP-only secure cookie)                  |
| Database           | **Neon** (serverless Postgres) for prod / local Postgres for dev  |
| DB driver / runtime| **`pg`** (node-postgres) on Vercel **Node** runtime, pooled URL   |
| ORM / migrations   | **Drizzle ORM** + drizzle-kit (better-auth uses its Drizzle adapter) |
| Validation         | Zod (shared client/server schemas)                                |
| Money math         | Integer minor units + a small helper (no floats)                 |
| Testing            | Vitest (unit), Playwright (e2e incl. virtual authenticator)      |
| Lint/format        | ESLint + Prettier                                                 |

> **Why these:** SvelteKit gives SSR + PWA + API routes in one app. Drizzle is
> type-safe and migration-friendly. **better-auth** handles magic-link email auth
> + passkeys + sessions (incl. adding multiple passkeys per account) and ships a
> SvelteKit handler and Svelte client; we run it passwordless (magic link for
> signup/recovery, passkey for fast login). shadcn-svelte matches your styling
> requirement.
>
> **Note on better-auth:** it owns its own auth tables via the Drizzle adapter
> (`user`, `session`, `account`, `verification`, `passkey`) — the `verification`
> table backs the magic-link tokens. Our domain tables (groups, members,
> transactions) reference better-auth's `user.id`. The passkey plugin runs in its
> **standard session-required mode** (a logged-in user adds a passkey), so no
> `resolveUser` / passkey-first wiring is needed. Magic-link delivery needs a
> `sendMagicLink` callback backed by the **Mailgun HTTP API** (API key + domain).
> (See §5.)

> **Tooling & setup notes:**
> - **Package manager: pnpm** for all installs/scripts (`pnpm install`,
>   `pnpm dev`, `pnpm dlx ...`).
> - **shadcn-svelte via its CLI.** Initialize with the shadcn-svelte command
>   (`pnpm dlx shadcn-svelte@latest init`) and add each component the same way
>   (`pnpm dlx shadcn-svelte@latest add button card dialog ...`). Do **not**
>   hand-author component files — pull them through the CLI.
> - **`@lucide/svelte` is typically installed during shadcn-svelte init**, so it
>   may not need a separate install. Verify it's present after init; only add it
>   explicitly if missing.
> - **Hosting: Vercel** → use `@sveltejs/adapter-vercel`. Vercel is serverless,
>   so the DB is **Neon** (serverless Postgres) reached over the network. Use
>   Neon's pooled connection string for serverless functions; use the
>   non-pooled/direct connection for drizzle-kit migrations. Local dev can run a
>   local Postgres (or a Neon dev branch). Set the Neon `DATABASE_URL`, auth
>   `rpID`/`origin`/`trustedOrigins`, and the Mailgun settings
>   (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_BASE_URL` for US vs EU region)
>   + a verified `from` address (`EMAIL_FROM`) as env vars in Vercel.
> - **Runtime & driver (decided):** Vercel **Node** runtime (`adapter-vercel`
>   default), using the **`pg`** (node-postgres) driver with the standard Drizzle
>   `pg` adapter over Neon's **pooled** URL. drizzle-kit migrations use the
>   **non-pooled/direct** URL. (Node runtime keeps better-auth + WebAuthn and a
>   conventional Postgres driver simple; `@neondatabase/serverless` would only be
>   needed for the edge runtime, which we're not using in v1.)

---

## 4. High-Level Architecture

```
SvelteKit app (SSR)
├── Routes (pages + form actions)         ← server-rendered UI, progressive enh.
├── /api/auth/[...all] (+server.ts)       ← better-auth handler (passkey, session)
├── Server services (lib/server/*)        ← business logic (debts, tx, access)
├── Drizzle data layer                    ← typed queries + migrations
└── Service worker (PWA)                  ← offline shell, caching
        │
        ▼
   Neon (serverless Postgres)
```

Runs on **Vercel** (`adapter-vercel`), serverless functions for SSR + the
better-auth handler, talking to Neon over its pooled connection.

Principles:
- **Server-first.** Use SvelteKit `load` + form `actions` so the app works
  without JS; layer PWA/offline on top.
- **Business logic in `lib/server/`**, not in routes, so it's testable.
- **Shared Zod schemas** in `lib/schemas/` used by both client and server.

---

## 5. Authentication (email magic link + passkey)

### 5.1 Concepts
- Auth is handled by **better-auth** with two **passwordless** methods:
  - **Email magic link** (better-auth **magic-link plugin**) — the **baseline
    credential**, used for **registration**, as an always-available login method,
    and as the **account-recovery** path.
  - **Passkey** (WebAuthn / FIDO2, better-auth **passkey plugin**) — enrolled
    **after the first login** as the fast, primary day-to-day login on a device.
- **No email/password** module and **no social login**. The email address is
  **verified implicitly** by clicking the magic link.
- because the passkey is added by an already-authenticated user, the passkey
  plugin runs in its **standard, session-required mode** — we do **not** need the
  passkey-first `requireSession:false` / `resolveUser` / signed-context mechanism
  at all. (This removes the main auth risk from earlier drafts.)
- better-auth manages users, sessions, magic-link verification tokens, and passkey
  credentials in its own tables (`user`, `session`, `account`, `verification`,
  `passkey`).
- A SvelteKit catch-all route mounts the better-auth handler
  (`/api/auth/[...all]/+server.ts`); the Svelte client (`createAuthClient` +
  `magicLinkClient` + `passkeyClient`) drives the flows in the browser.

### 5.2 Setup
- Server: `betterAuth({ database: drizzleAdapter(...), plugins: [
  magicLink({ sendMagicLink }), passkey({ rpID, rpName: "Pay with me", origin }) ]
  })`. (`rpName` is what the OS passkey prompt shows.)
- `emailAndPassword` is **not** enabled; no social providers.
- **Email delivery (new dependency):** the magic-link plugin's
  `sendMagicLink({ email, url })` callback sends the link via the **Mailgun HTTP
  API** (`POST https://<base>/v3/<domain>/messages`, HTTP basic auth `api:<key>`).
  Use the **`mailgun.js`** SDK or a plain `fetch` — no SMTP, so there's no
  per-invocation handshake on serverless. Config via env vars: `MAILGUN_API_KEY`,
  `MAILGUN_DOMAIN`, `MAILGUN_BASE_URL` (`https://api.mailgun.net` for US or
  `https://api.eu.mailgun.net` for EU), and `EMAIL_FROM` (a verified Mailgun
  sender on that domain). Wrap it in one small `lib/server` email helper so it's
  swappable. (See §3, §12.)
- Email is **required and unique** per account (stored on `user.email`); it is the
  identifier the magic-link flow matches on and is never exposed across groups
  (§12).

### 5.3 Registration / first login (magic link)
1. User enters their **email** and **display name** on the register page.
2. `authClient.signIn.magicLink({ email, name })` → the server creates-or-loads
   the user and emails a **single-use, short-lived** magic link (token in the
   `verification` table).
3. The user clicks the link; better-auth verifies the token, marks the email
   verified, sets the session cookie, and lands them in the app.
4. First-time users are then **prompted to enrol a passkey** (§5.4). They may skip
   and keep using magic-link login.

### 5.4 Passkey enrolment (after login)
- While authenticated, the client calls `authClient.passkey.addPasskey()`; the
  browser creates the credential and better-auth stores it against the user.
- Offered right after the first login (onboarding nudge) and anytime from
  `/settings`. **Multiple passkeys per account** are supported (add a second
  device).

### 5.5 Login flow (returning users)
- **Primary:** `authClient.signIn.passkey()` — supports **discoverable /
  usernameless** credentials and conditional UI / autofill; the fast path on an
  enrolled device.
- **Fallback / new device / lost passkey:** email magic link (§5.3), always
  available. Both methods set the same better-auth session cookie.

### 5.6 Recovery — via email magic link
- **Recovery exists in v1** (changed from the earlier passkey-only draft). Losing
  every passkey is **not** fatal: the user logs in with an email magic link and
  re-enrols a passkey on the new device.
- This depends on continued access to the **email account** — that email is the
  root of account access. No secondary recovery (no recovery codes) in v1.
- Still recommend enrolling **multiple passkeys** for day-to-day convenience.

### 5.7 Session management
- Sessions/cookies are managed by better-auth (HTTP-only, Secure, `SameSite=Lax`).
- In `hooks.server.ts`, resolve the better-auth session and attach
  `event.locals.user` / `event.locals.session` for downstream `load`/actions.

---

## 6. Groups & Members

### 6.1 Model
- **Group**: id, name, **settlement currency** (required; the base currency all
  balances and settlements are expressed in), created_by, timestamps.
- **Member**: belongs to a group; has a display name; **optionally** linked to a
  `user_id` (nullable, references better-auth `user.id`). This lets you add
  people who don't have accounts.
- **Access**: a user can access multiple groups. Access is granted when the user
  is linked to at least one member in that group (no separate membership table —
  the `members.user_id` link is the source of truth).

### 6.2 Member ↔ User linking (Invite link)
A member is a *participant slot* in a group's ledger. It may or may not map to a
real account holder. v1 uses **invite links only**:

The invite link is **reusable with a 7-day expiry**: one link can be shared with
several people and accepted multiple times until it expires (or is revoked). A
group may have **multiple active links at once**, each managed via a **revocation
UI** (see §10).

Flow:
1. A group member generates an **invite link** (token) for the group. It expires
   **7 days** after creation (default). The link may optionally target a specific
   **unlinked member** (the slot to fill), or be open (creates a new member on
   accept). Multiple links can be active simultaneously.
2. The invitee opens the link. **Accepting always requires a registered,
   logged-in user** — there is no anonymous/guest accept. If not logged in, they
   must register or log in via passkey first, then continue the accept.
3. If the token is **valid and unexpired**, on accepting the user is **assigned
   to the member**: set `members.user_id = currentUser`. If the link was **open**,
   a **new member is created and linked**, with its `display_name` defaulting to
   the accepting **user's display name** (editable afterwards in member
   management).
4. The link stays valid for further accepts until it expires or is revoked
   (reusable). A **member-targeted** link, however, is effectively single-use:
   once that slot is claimed it can't be claimed again.

Rules:
- Unlinked members still appear in transactions and debt math.
- A user can be linked to members across many groups (multi-group access).
- A user must not be linked to **more than one member in the same group** —
  enforce on accept (if they're already a member of the group, the accept is a
  no-op / friendly message).
- Accepting a group invite grants that user access to the group.
- Expired (>7 days) or revoked links show a clear error and cannot be accepted.
- A member-managing screen lists active links with create / copy / **revoke**
  actions, plus their expiry and (optionally) a usage count.

### 6.3 Member lifecycle (removal)
- A member is **soft-deactivated**, not hard-deleted, once they have any activity
  (a payer/share row in any transaction). Use a `members.deactivated_at` flag.
- A deactivated member **stays in past transactions and in balance/debt math** —
  the ledger is never rewritten. They simply disappear from pickers when creating
  or editing transactions, and are visually marked "inactive" in member lists.
- A member with **zero activity** may be hard-deleted (cleanup of a mistyped slot).
- Deactivating does **not** clear outstanding balances; the suggested-settlement
  view still shows what they owe / are owed until settled. (Reactivation is a
  simple flag flip; nice-to-have.)
- If the member was linked to a user, deactivation removes that user's access to
  the group (they no longer have an active member link).

### 6.4 Group lifecycle (currency lock, deletion)
- The **settlement currency** is editable only while the group has **no
  transactions**. After the first transaction it is **locked** — changing it would
  invalidate every stored settlement-currency total and per-transaction rate
  (we can't re-derive historical rates). Surface this in the edit UI. (Per-
  transaction *entry* currency is always free; only the group's settlement
  currency locks.)
- **Group rename** is always allowed.
- **Deletion is a soft-delete** (`groups.deleted_at`): the group is hidden from
  every member's list and its routes return not-found, but the data is retained
  and recoverable. No hard-delete in v1.

---

## 7. Transactions

### 7.1 Common fields
- `id`, `group_id`, `type` (`spending` | `transfer`), `title`,
  `category_id`, `split_mode`, `amount_total` (minor units **of the transaction
  currency**), `created_by`, `occurred_at`, `created_at`, `updated_at`,
  `deleted_at` (soft delete).
- **Timestamp semantics (decided):**
  - `created_at` — the **real-world date the transaction took place**.
    **User-editable** and may be backdated (e.g. recording yesterday's dinner
    today); defaults to now on first entry. This is the date shown and sorted on
    in transaction lists.
  - `occurred_at` — the **server timestamp set to now** when the row is created;
    **immutable** (never edited, never backdated).
  - `updated_at` — server timestamp, bumped on every edit.
  - *(Note: this assigns `created_at` to the editable real-world date and
    `occurred_at` to the immutable insert time — the reverse of the usual
    convention. Naming is intentional per the product decision; keep it consistent
    across schema, queries, and UI.)*
- **Currency & FX (see §7.6):**
  - `currency` — the transaction's entry currency (defaults to the group's
    settlement currency). May differ from the group's settlement currency.
  - `exchange_rate` — manual rate, settlement-currency units per **1** unit of
    `currency`. Implicitly `1` (and hidden in the UI) when `currency` ==
    settlement currency.
  - `amount_total_settlement` — `amount_total` converted to the settlement
    currency (minor units), computed once and stored as the canonical value the
    debt engine reads.
- For itemized: `amount_total = items_subtotal + Σ charges` (see §7.2.1–7.2.3),
  all in the **transaction currency**; conversion to settlement happens after
  resolution (§7.6).

### 7.2 Payers & beneficiaries (split lines)
A single transaction references multiple members on each side, stored as line
items:

- **transaction_payer**: `(transaction_id, member_id, amount_paid)`
  — who put money in, and how much.
- **transaction_share**: `(transaction_id, member_id, amount_owed, share_weight?,
  raw_amount?)` — who benefited and their **resolved** share.

The transaction records the **split mode** used to derive the shares:
`split_mode ∈ { equal, amount, share, itemized }`.

- **equal** — split `amount_total` evenly across selected beneficiaries.
  `amount_owed` computed; store nothing extra.
- **amount** — user enters an exact amount per beneficiary (`raw_amount`).
  `amount_owed = raw_amount`. Validate `Σ raw_amount == amount_total`.
- **share** — user enters integer/decimal **weights** (`share_weight`) per
  beneficiary. `amount_owed = amount_total × weight / Σ weights`.
- **itemized** — see §7.2.1. The transaction is broken into line items; each
  item is split independently, then per-member amounts are aggregated across all
  items into `transaction_share.amount_owed`.

In all modes we persist the **resolved `amount_owed`** at the transaction level
(source of truth for debt math) *and* the inputs (`split_mode`,
`share_weight`/`raw_amount`, and for itemized the item rows) so the transaction
can be re-edited faithfully.

**Rounding:** distribute remainders deterministically (largest-remainder method)
so the resolved shares sum exactly to the total in minor units. **Tie-break:**
when two members have equal remainders, the leftover minor unit goes to the
member with the **lower `member_id`** (ascending `member_id`), so distribution is
fully reproducible and unit-testable. For itemized, round **within each item**
first, then aggregate (so each item's shares sum to that item's amount, and the
items sum to `amount_total`). The same ascending-`member_id` tie-break applies to
charge/discount allocation (§7.2.3) and FX share distribution (§7.6).

#### 7.2.1 Itemized splitting
An itemized spending is a list of **line items**, each with its own amount and
its own set of beneficiaries + per-item split mode:

- **transaction_item**: `(id, transaction_id, label, amount)` — one line of the
  receipt (e.g. "Pizza", "Beers"). `items_subtotal = Σ item.amount`.
- **transaction_item_share**: `(item_id, member_id, amount_owed, split_mode,
  share_weight?, raw_amount?)` — who shares *this item* and how it's split
  (equal/amount/share per item).

#### 7.2.2 Charges & discounts: service charge, VAT, discount
Real bills add **service charge** and **VAT** *on top of* the item prices
("exclusive"), and sometimes a **discount** (a coupon, promo, or bill-level
reduction). All of these **vary per spending** (different restaurants, some 0%,
discount only sometimes) — there is **no group default**; they're entered fresh
each time. Model them as per-transaction "charge" rows (a discount is just a
negative-effect charge):

- **transaction_charge**: `(transaction_id, kind, mode, value, base, sort_order)`
  - `kind`: `service` | `vat` | `discount` (extensible later: `tip`)
  - `sign`: derived from `kind` — `service`/`vat`/`tip` **add**, `discount`
    **subtracts**. `value` is always stored as a positive magnitude.
  - `mode`: `percent` (basis points, e.g. 1000 = 10%) or `absolute` (minor units)
  - `base`: what a `percent` applies to — `items_subtotal` or `running_total`
    (subtotal ± previously-applied charges). Lets you express VAT-on-(subtotal +
    service) and discount-before-tax vs discount-after-tax.
  - `sort_order`: application order. Charges/discounts are applied in this order,
    each computed against its `base` at that point.

`amount_total = items_subtotal + Σ (signed charge effects, applied in order)`.

Two common discount placements (both expressible via `base` + `sort_order`):
```
# Discount on the subtotal (before tax) — e.g. 10% off food:
items_subtotal = Σ item.amount
discount  = round(items_subtotal × d_rate)            base = items_subtotal   (−)
service   = round((items_subtotal − discount) × s_rate) base = running_total   (+)
vat       = round((items_subtotal − discount + service) × v_rate) base = running_total (+)
amount_total = items_subtotal − discount + service + vat

# Discount on the final total (after tax) — e.g. a flat 100 coupon:
... service, vat applied first ...
discount  = 100 (absolute)                             base = running_total    (−)
amount_total = items_subtotal + service + vat − discount
```

#### 7.2.3 Resolution (itemized + charges/discounts)
1. For each item, resolve per-member owed amounts (equal/amount/share, with
   largest-remainder rounding **within the item**). Sum per member across items
   → each member's **subtotal share**.
2. Compute each charge/discount total in `sort_order` per §7.2.2 (a discount is
   a negative effect).
3. **Allocate each charge/discount** to members in proportion to their subtotal
   share, using largest-remainder rounding so the allocations sum exactly to that
   charge/discount total. A discount is allocated the same way (negative), so
   everyone's share of the bill is reduced proportionally to what they consumed.
4. Each member's owed (**in the transaction currency**) = subtotal share +
   allocated charges − allocated discounts. These sum exactly to `amount_total`.
5. Payers remain at the transaction level (who paid the overall bill, net of
   discount), unchanged — also in the transaction currency.
6. **Currency conversion (§7.6):** if the transaction currency differs from the
   group's settlement currency, convert each member's owed and each payer's paid
   into the settlement currency (control sum = the rounded settlement total, with
   largest-remainder so they still tie out). The resulting **settlement-currency**
   amounts are what land in `transaction_share.amount_owed` /
   `transaction_payer.amount_paid_settlement` — the canonical values §8 reads.
   When the two currencies match, this step is a no-op (rate 1).

Why this shape: the debt engine (§8) keeps reading only the aggregated
`transaction_share` rows (always in the settlement currency), so balance/
settlement math is **unchanged** by itemization, charges, discounts, **or FX** —
they're purely an input/detail layer that derives the settlement-currency shares.

Notes/edge cases:
- A member can appear in some items and not others; their total owed is the sum
  of just the items they're in, plus/minus their proportional charges/discounts.
- Charges/discounts with value 0 (or none) → itemized total is just the items.
- Itemized + charges/discounts apply to **Spending** only in v1 (Transfers are
  not itemized).
- Items with zero beneficiaries are invalid (see §7.4).
- A member who shares no items owes no charges and gets no discount (subtotal
  share is 0).
- `mode = absolute` charges/discounts are also allocated proportionally to
  subtotal share.
- A discount must not exceed its base / drive `amount_total` below 0 — validate
  (see §7.4); a 100%-off bill resolves all shares to 0.

For **Spending**: payers paid; beneficiaries owe their share.

For **Transfer**: a movement of money from payer member(s) → recipient
member(s). Model the recipient as the "share" side. A transfer that settles a
debt is just a normal transfer transaction (`split_mode = amount` typically).

### 7.3 Categories — fixed system list
- `category`: id, name, `icon` (a **lucide icon name** string), `applies_to`
  (`spending` | `transfer`), `sort_order`.
- **Fixed, seeded list** — not user/group-editable in v1. Seeded via migration.
- Icons are stored as lucide names and rendered via `@lucide/svelte` (dynamic
  import by name). The app is **general-purpose** — the same category set serves
  both travel and non-travel groups (Travel is just one category among many).

**Spending categories** (name → lucide icon):

| Category        | lucide icon       |
|-----------------|-------------------|
| Food & Drink    | `utensils`        |
| Groceries       | `shopping-basket` |
| Transportation  | `car`             |
| Rent / Housing  | `house`           |
| Utilities       | `zap`             |
| Entertainment   | `clapperboard`    |
| Shopping        | `shopping-bag`    |
| Travel          | `plane`           |
| Health          | `heart-pulse`     |
| Other           | `shapes`          |

**Transfer categories** (name → lucide icon):

| Category        | lucide icon       |
|-----------------|-------------------|
| Debt settlement | `handshake`       |
| Cash            | `banknote`        |
| Bank transfer   | `landmark`        |
| Other           | `shapes`          |

- The transaction form shows only the categories whose `applies_to` matches the
  selected transaction type.

**Category meanings** (to keep the overlapping ones distinct, since v1 is a flat
list with no sub-categories — applies whether or not the group is travel-focused):
- **Travel** = trip-specific costs: accommodation (hotels/Airbnb), flights and
  long-distance tickets, tours/activities, baggage, travel insurance.
- **Transportation** = everyday local movement: bus/metro/taxi/ride-share, fuel,
  parking, tolls — including local rides *while* on a trip.
- **Food & Drink** = all meals, including meals during a trip.

### 7.4 Validation rules
- `sum(amount_paid) == amount_total` (both in the transaction currency).
- `sum(resolved amount_owed) == amount_total` (transaction currency).
- **Settlement side ties out:** `sum(amount_paid_settlement) ==
  sum(amount_owed [settlement]) == amount_total_settlement`.
- **FX:** `currency` must be a supported currency; if `currency` == settlement
  currency then `exchange_rate` is `1`; otherwise `exchange_rate > 0` is
  **required** (within a sane precision, see §7.6). `amount_total_settlement`
  must equal the documented conversion of `amount_total` at `exchange_rate`.
- At least one payer and one beneficiary.
- Members must belong to the transaction's group.
- For `split_mode = amount`: `Σ raw_amount == amount_total`.
- For `split_mode = share`: `Σ share_weight > 0`.
- For `split_mode = itemized`:
  - At least one item; each item `amount > 0` and has ≥1 beneficiary.
  - Each item's own split is valid (amount/share rules above, per item).
  - `amount_total == items_subtotal + Σ (signed charges/discounts)` (per §7.2.2).
  - Charge/discount `value` is a non-negative magnitude (sign comes from `kind`).
  - `mode = percent` value stored as **basis points**, integer in range
    **0–10000** (0–100.00%).
  - Total **discount must not exceed** its base, and `amount_total >= 0`.

### 7.5 Money representation
- Stored everywhere as **integer minor units** — **no floating point** in money
  math. All arithmetic (splits, balances, settlements) is done in minor units.
- **Precision is per-currency, not a fixed 2dp.** Each currency has a minor-unit
  **exponent**: JPY/KRW/VND = 0, THB/USD/EUR = 2, KWD/BHD/TND = 3. The scale
  factor is `10^exponent` (×1 / ×100 / ×1000), not a hardcoded ×100.
  - Keep a small **currency table/constant** mapping code → { exponent, symbol,
    display format }, seeded with the **supported currency list** below (§7.5.1).
    Exponents follow ISO 4217 minor units.
  - Each amount is interpreted with **its own** currency's exponent: a
    transaction's entry amounts use the transaction currency's exponent; balances/
    settlements use the group settlement currency's exponent. The settlement
    currency locks after the first transaction (§6.4), so the settlement exponent
    never changes under existing data.
- A `lib/money` helper is **currency-aware**: parse (string→minor, using the
  currency's exponent), format (minor→display string at the right dp + symbol),
  and largest-remainder distribution for splits (remainder is in that currency's
  smallest unit). All split/charge/discount rounding (§7.2.3) uses this.
- **Two currencies are in play** (see §7.6): a transaction is entered and split
  in its **transaction currency** (using that currency's exponent), then the
  resolved per-member amounts are converted to the group's **settlement
  currency** (using *its* exponent) for all balance/debt math. The money helper
  is told which currency it's operating in for every parse/format/round.

#### 7.5.1 Supported currencies (v1)

**Fixed, seeded list of 29 fiat currencies** (the top 30 by market cap from
fiatmarketcap.net, **excluding BTC** — it is not a fiat currency and its
8-decimal, non-ISO-4217 minor units don't fit the exponent model). Both the
group **settlement currency** and a transaction's **entry currency** must be one
of these. Seeded via migration into the currency constant/table; the `exponent`
column drives all minor-unit math (§7.5).

| #  | Code | Currency               | Exponent | Symbol |
|----|------|------------------------|----------|--------|
| 1  | CNY  | Chinese Yuan           | 2        | CN¥    |
| 2  | USD  | US Dollar              | 2        | $      |
| 3  | EUR  | Euro                   | 2        | €      |
| 4  | JPY  | Japanese Yen           | 0        | ¥      |
| 5  | GBP  | Pound Sterling         | 2        | £      |
| 6  | KRW  | South Korean Won       | 0        | ₩      |
| 7  | HKD  | Hong Kong Dollar       | 2        | HK$    |
| 8  | TWD  | New Taiwan Dollar      | 2        | NT$    |
| 9  | CAD  | Canadian Dollar        | 2        | CA$    |
| 10 | RUB  | Russian Ruble          | 2        | ₽      |
| 11 | BRL  | Brazilian Real         | 2        | R$     |
| 12 | CHF  | Swiss Franc            | 2        | CHF    |
| 13 | MXN  | Mexican Peso           | 2        | MX$    |
| 14 | INR  | Indian Rupee           | 2        | ₹      |
| 15 | SAR  | Saudi Riyal            | 2        | SAR    |
| 16 | AED  | UAE Dirham             | 2        | AED    |
| 17 | PLN  | Polish Zloty           | 2        | zł     |
| 18 | THB  | Thai Baht              | 2        | ฿      |
| 19 | SGD  | Singapore Dollar       | 2        | S$     |
| 20 | VND  | Vietnamese Dong        | 0        | ₫      |
| 21 | MYR  | Malaysian Ringgit      | 2        | RM     |
| 22 | TRY  | Turkish Lira           | 2        | ₺      |
| 23 | IDR  | Indonesian Rupiah      | 2        | Rp     |
| 24 | SEK  | Swedish Krona          | 2        | kr     |
| 25 | ILS  | Israeli New Shekel     | 2        | ₪      |
| 26 | NOK  | Norwegian Krone        | 2        | kr     |
| 27 | CZK  | Czech Koruna           | 2        | Kč     |
| 28 | PHP  | Philippine Peso        | 2        | ₱      |
| 29 | ZAR  | South African Rand     | 2        | R      |

- Where symbols collide (`¥` for CNY/JPY, `kr` for SEK/NOK, `$`-family), the
  display helper **prefixes the ISO code** to disambiguate (e.g. `CN¥` vs `JP¥`,
  or `SEK kr` vs `NOK kr`) so amounts in different currencies are never confused.
- All 29 use exponent 0 or 2; no 3-decimal currency is in this set. The money
  helper still supports arbitrary exponents (§7.5) so 3-decimal currencies remain
  addable later without code changes.

### 7.6 Multi-currency & manual FX

A group settles in **one settlement currency**. Any transaction may be entered
in a **different currency** with a **manual exchange rate** (no rate API).

**Rate convention.** `exchange_rate` = settlement-currency units per **1** unit
of the transaction currency (e.g. group settles in THB, bill in CNY, rate
`4.85` → 1 CNY = 4.85 THB). When transaction currency == settlement currency the
rate is `1` and the FX UI is hidden.

**Storage & precision.** Store the rate as **`numeric(18,6)`** (exactly 6 decimal
places), never as binary float, and require **`exchange_rate > 0`** for foreign
transactions (§7.4). Conversion math is done with integer/bignum scaling, not
floats:

```
amount_settlement_minor =
  round( amount_txn_minor / 10^exp_txn        -- → major units in txn currency
         * exchange_rate                       -- → major units in settlement
         * 10^exp_settlement )                 -- → settlement minor units
```
(`round` = round-half-up; implemented via integer arithmetic so it's exact.)

**Where conversion happens.** Splitting/itemization/charges all run **in the
transaction currency** (§7.2–§7.2.3) and produce each member's owed + each
payer's paid in transaction-currency minor units. Then a single conversion step:
1. Compute the **canonical settlement total**:
   `amount_total_settlement = convert(amount_total)` (one rounded value).
2. Distribute that settlement total across members in proportion to their
   transaction-currency owed, using **largest-remainder** rounding → each
   `transaction_share.amount_owed` (settlement minor units). Sums to
   `amount_total_settlement` exactly.
3. Do the same for payers → `transaction_payer.amount_paid_settlement`.

Converting once at the total (then distributing) — rather than converting each
share independently — guarantees paid and owed both tie to the same settlement
total, so group balances always sum to 0.

**What the debt engine sees.** §8 reads **only** the settlement-currency
`amount_owed` / `amount_paid_settlement`. It never sees rates or foreign amounts,
so balances and simplified settlements are unchanged.

**UX (entry).** On a transaction the user picks the currency (defaults to the
group's). If it differs, an FX field appears. To reduce friction, allow entering
**either** the rate **or** the settlement-equivalent total — the other is derived
(`rate = settlement_total / txn_total`), and the form shows the live converted
total (e.g. "¥200 → ฿970"). The stored canonical is the rate + computed
`amount_total_settlement`.

**Display.** Transaction lists/detail show the **original** amount + currency
(e.g. ¥200) with the settlement equivalent (฿970) as secondary text. Balances,
"who should pay", and settlement suggestions are shown **only** in the settlement
currency.

**Settle action.** Suggested settlements are computed in the settlement currency,
so a settle-up Transfer defaults to the **settlement currency at rate 1**. The
user may still record the actual transfer in another currency with its own rate
(e.g. they paid in cash CNY) — it converts back the same way.

**Edge cases.** Rate `> 0` required for foreign transactions; a 0 or missing rate
is invalid (§7.4). Re-editing a transaction can change the rate; the settlement
amounts re-resolve. Changing the transaction currency to match the settlement
currency clears the rate to 1.

---

## 8. Debt Summarization & Settlement

All balance/settlement math runs in the group's **settlement currency**, using
the per-transaction settlement-converted amounts (`amount_paid_settlement` /
`amount_owed`, see §7.6). Foreign-currency entry and rates are invisible here.

### 8.1 Net balance per member
For each member in a group (all terms in settlement-currency minor units):
```
balance(member) = Σ amount_paid_settlement(member)  −  Σ amount_owed(member)
```
- Positive balance → member is owed money (creditor).
- Negative balance → member owes money (debtor).
- Sum of all balances in a group == 0.

### 8.2 "Who should pay" (most debt)
Sort members by balance ascending; the most negative is the member who should
pay first. Surface this prominently per your note.

### 8.3 Suggested settlements (simplified — minimize transfers)
v1 shows **simplified suggestions only** (a minimized set of transfers), not raw
pairwise per-transaction debts. Use a greedy debt-simplification algorithm:
1. Split members into creditors (balance > 0) and debtors (balance < 0).
2. Repeatedly match the largest debtor with the largest creditor; create a
   suggested transfer of `min(|debtor|, creditor)`; reduce both.
3. Continue until all balances ~0.

This yields a minimal set of "X pays Y amount Z" suggestions, which is what the
settle screen displays.

### 8.4 Settle action
- From a suggested settlement, prefill a **Transfer** transaction (payer =
  debtor member, recipient = creditor member, amount, category = "Debt settlement").
- On save it's a normal transaction, so balances recompute naturally and the
  suggestion list shrinks.

---

## 9. Data Model (Drizzle sketch)

> Indicative only — names/types to be finalized. Money = integer minor units.

```
-- Managed by better-auth (Drizzle adapter) — DO NOT hand-roll. Shown for context:
user             (id, name, email, emailVerified, image?, createdAt, updatedAt)
                  -- email required + unique; magic-link identity (§5.2)
session          (id, userId, token, expiresAt, ...)
account          (id, userId, ...)
verification     (id, ...)   -- backs magic-link tokens (single-use, short-lived)
passkey          (id, userId, credentialID, publicKey, counter, deviceType,
                  backedUp, transports, ...)   -- passkey plugin

-- Our domain tables (reference better-auth user.id):
groups           (id, name, settlement_currency, created_by, created_at,
                  deleted_at?)   -- settlement currency locked after 1st txn; soft-delete
                  -- currency code → exponent/symbol resolved via a currency constant (§7.5)
members          (id, group_id, display_name, user_id?,  -- nullable, → user.id
                  deactivated_at?)   -- soft-deactivate; stays in ledger (§6.3)
invites          (id, group_id, token, member_id?,       -- member_id targets a slot
                  expires_at, revoked_at?, created_by, created_at)  -- reusable + expiry

categories       (id, name, icon, applies_to)         -- spending|transfer (seeded, fixed)

transactions     (id, group_id, type, title, category_id,
                  amount_total,          -- minor units of THIS txn's currency
                  currency,              -- entry currency (defaults to group settlement)
                  exchange_rate,         -- settlement units per 1 txn unit; 1 if same (§7.6)
                  amount_total_settlement, -- canonical: amount_total converted (minor units)
                  split_mode,            -- equal|amount|share|itemized
                  created_by, occurred_at, created_at, updated_at, deleted_at)
transaction_payers (transaction_id, member_id,
                  amount_paid,           -- txn-currency minor units (input)
                  amount_paid_settlement)-- RESOLVED settlement minor units (what §8 reads)
transaction_shares (transaction_id, member_id,
                  amount_owed,           -- RESOLVED settlement minor units, aggregated (§8)
                  share_weight?, raw_amount?)  -- txn-currency inputs for re-edit (non-itemized)

-- Itemized splitting (only when split_mode = itemized):
transaction_items       (id, transaction_id, label, amount, sort_order)
transaction_item_shares (item_id, member_id, amount_owed,    -- resolved per item
                  split_mode, share_weight?, raw_amount?)    -- per-item inputs
transaction_charges     (id, transaction_id, kind,           -- service|vat|discount(|tip)
                  mode,                  -- percent(bps) | absolute(minor units)
                  value,                 -- positive magnitude; sign derived from kind
                  base,                  -- items_subtotal | running_total
                  sort_order)            -- application order (discount-before/after-tax)

-- Append-only audit trail (§12.1):
audit_log        (id, group_id, actor_user_id,  -- → user.id (who performed it)
                  action,                -- create|edit|delete|restore|add|deactivate|...
                  entity_type,           -- transaction|member|invite|group
                  entity_id,             -- may dangle after hard-delete (keep label below)
                  summary,               -- human-readable line (denormalized, durable)
                  metadata?,             -- JSON: changed fields / before-after snapshot
                  occurred_at)           -- server UTC; sort key (DESC in UI)
                  -- index (group_id, occurred_at DESC); (entity_type, entity_id)
```

Notes:
- `created_by` references better-auth `user.id`.
- `transactions.currency` is the entry currency (defaults to
  `groups.settlement_currency`); `amount_total` is in that currency's minor units,
  and `amount_total_settlement` is its conversion at `exchange_rate` (§7.6).
- `transaction_shares.amount_owed` and `transaction_payers.amount_paid_settlement`
  are always in the **settlement** currency — the only amounts §8 reads.
- `transaction_shares` always holds the **resolved, aggregated** per-member owed
  (source of truth for §8). For itemized, it's derived from
  `transaction_item_shares` + `transaction_charges`; the item/charge tables are
  the editable inputs.
- Unique constraint to enforce "one member per user per group":
  `unique(members.group_id, members.user_id)` (where `user_id` not null).

- `audit_log` is **append-only** (no update/delete), written in the same DB
  transaction as the mutation; `actor_user_id` → `user.id`; `summary` is
  denormalized so entries stay readable even if the entity later changes or is
  hard-deleted (§12.1).

Indexes: `members(group_id)`, `members(user_id)`, `invites(token)`,
`transactions(group_id, occurred_at)`, `transaction_payers(transaction_id)`,
`transaction_shares(transaction_id)`, `transaction_items(transaction_id)`,
`transaction_item_shares(item_id)`, `transaction_charges(transaction_id)`,
`audit_log(group_id, occurred_at DESC)`, `audit_log(entity_type, entity_id)`.

---

## 10. Routes & UI

```
/                         Landing / redirect to dashboard if logged in
/login                    Login: passkey (primary) + "email me a link" fallback
/register                 Register: enter email + display name → magic link sent
/auth/magic-link          Magic-link landing (verifies token, sets session); the
                          token verify itself is handled by /api/auth/[...all]
/onboarding/passkey       Post-first-login nudge to enrol a passkey (skippable)
/groups                   Dashboard: list of user's groups + balances
/groups/new               Create group
/groups/[id]              Group overview: balance summary + recent transactions
/groups/[id]/members      Manage members; create/copy/revoke invite links (7-day
                          expiry, multiple active); link/claim
/groups/[id]/transactions Full transaction list (filter by type/category)
/groups/[id]/transactions/new   Add spending/transfer (type toggle; split-mode
                          picker incl. itemized with items + service/VAT/discount)
/groups/[id]/transactions/[txid]  View/edit transaction
/groups/[id]/settle       Debt summary + suggested settlements + settle action
/groups/[id]/activity     Audit log: who did what & when (newest first) (§12.1)
/settings                 Manage passkeys (add/remove additional devices); email
/invite/[token]           Accept an invite link (assign member, grant access)
```

UI building blocks (shadcn-svelte): Button, Card, Dialog, Drawer/Sheet (mobile
add-transaction), Form + Input + Select, Tabs (spending/transfer), Avatar,
Badge, Table/list, Toast, Separator. Mobile-first layout.

**Currency & FX (all transaction types):** a currency picker defaulting to the
group's settlement currency. When a **different** currency is chosen, an FX field
appears — the user enters the **rate** *or* the **settlement-equivalent total**
(the other is derived), and the form shows the live conversion (e.g. "¥200 →
฿970"). Hidden entirely when the transaction is in the settlement currency. (§7.6)

**Itemized transaction form:** a repeatable list of item rows (label, amount,
beneficiaries + per-item split), plus a charges section for **service charge**,
**VAT**, and **discount** (each percent or absolute, with order/placement), with
a **live computed breakdown** (items subtotal → ± discount → + service → + VAT →
total, and each member's resolved share) so the user sees exactly who owes what
before saving. Rates/discounts are entered per spending (no saved defaults). All
item/charge amounts are in the **transaction currency**; the breakdown also shows
the settlement-converted total when a foreign currency is used.

---

## 11. PWA

- Web App Manifest: `name` = **"Pay with me"** (`short_name` e.g. "PayWithMe"),
  icons (192/512 + maskable), theme/background color, `display: standalone`,
  start_url.
- Service worker via `@vite-pwa/sveltekit`:
  - Precache the app shell.
  - Runtime cache static assets.
  - Network-first for data; show graceful offline state.
- "Add to home screen" install prompt handling.
- **No offline creation in v1.** Writes (transactions, groups, members) require
  connectivity. The service worker provides an installable app + offline shell
  and may cache previously loaded data for read-only viewing, but creating/editing
  while offline is explicitly out of scope. Show a clear "you're offline" state
  that disables write actions.

### 11.1 PWA & auth sessions

PWA caching plus passkey/cookie sessions has a few specific pitfalls. These are
SW-config + session-handling rules; none change the data model.

- **Never cache authenticated responses in the service worker.** This is the
  classic PWA auth leak: a cached SSR page or `/api` response can be served to a
  different user — or a logged-out user — exposing another person's private data.
  Workbox config:
  - **Precache only static/build assets** (JS, CSS, icons, fonts).
  - **NetworkOnly** for navigations and all data / `/api/**` (including
    `/api/auth/**`) routes — no `StaleWhileRevalidate` on personalized content.
  - The precached HTML shell must be **auth-agnostic**: it must not embed
    server-rendered user data. Session-gated data is fetched from the network on
    load; the SW never serves it from cache.
- **iOS standalone has a separate cookie/storage jar.** An installed PWA on iOS
  historically does **not** share cookies with Safari, so a browser login does
  not carry into the installed app — the user must authenticate *inside* the
  installed PWA. The passkey itself lives in the platform keychain and is still
  available; it's the better-auth **session cookie** that's siloed. Document this
  so it isn't mistaken for a bug.
- **Magic links open in the default browser, not the installed PWA.** Tapping the
  emailed link launches Safari/Chrome, so the session cookie lands in the
  *browser's* jar — on iOS that is **not** the installed PWA's jar (above). So
  prefer **passkey login inside the installed app**; treat magic link as the
  browser / new-device / recovery path. Make the magic-link landing page work
  standalone (don't assume it reopens the PWA), and after verifying, guide the
  user to enrol a passkey so subsequent logins happen in-app.
- **Treat auth state as server-driven; handle 401 gracefully.** A PWA can stay
  open for days and the session cookie will expire under it. The client must
  never assume "logged in" from cached UI: on any `401`, clear client state and
  route to login. Session validation happens per request in `hooks.server` /
  `load`, never from SW cache.
- **WebAuthn secure context + RP ID.** PWA is HTTPS (fine), but `rpID` must match
  the production origin (and `localhost` for dev) and must **not** be hardcoded to
  a Vercel preview URL, or registration/auth in standalone mode breaks. (See §12.)
- **Cookie attributes.** better-auth defaults (httpOnly, Secure, `SameSite=Lax`)
  are correct; everything is same-origin, so don't loosen to `SameSite=None`.
- **SW update vs. stale client code.** On deploy a stale SW can keep serving old
  JS that calls changed auth endpoints. Use a prompt-to-reload (or controlled
  `skipWaiting`) so auth flows don't break across versions.

---

## 12. Security & Privacy

- Cookies/sessions handled by better-auth (HTTP-only, Secure, SameSite).
- **PWA session/caching rules: see §11.1** — the service worker must never cache
  authenticated responses, and the client must treat auth state as server-driven
  (handle `401` by clearing state and re-authenticating).
- CSRF protection on form actions (SvelteKit built-in + origin checks).
- Rate-limit auth endpoints (better-auth has built-in rate limiting; configure).
  In particular **rate-limit magic-link requests per email/IP** to prevent email
  bombing and enumeration.
- Configure better-auth/passkey `rpID`, `origin`, and `trustedOrigins` strictly
  per environment.
- **Magic-link tokens** are **single-use and short-lived** (better-auth default
  expiry; keep it short, e.g. ~5–15 min). The link must be HTTPS to the canonical
  origin (not a preview URL). Keep the `MAILGUN_API_KEY` server-side only.
- Authorization is **group-membership based only** (no per-action roles in v1):
  any user with access to a group can create/edit/delete that group's
  transactions and members. The single enforced check is that the requesting
  user has access to the group (via a linked member). Enforce in `lib/server`.
- Don't leak member emails to other groups.
- **Accountability via audit log (see §12.1):** because anyone can mutate
  anything, every create/edit/delete is recorded with *who* and *when*.

### 12.1 Audit log

Since there are no per-action permissions, the audit log is the safety
mechanism: it makes every change **attributable** and **reviewable**, even though
it doesn't prevent the change.

**What's recorded.** One append-only entry per mutating action:
- **Transactions** (priority): `create`, `edit`, `delete` (soft-delete),
  `restore`.
- Also recommended for v1 (same mechanism): member `add` / `deactivate` /
  `reactivate`, invite `create` / `revoke`, group `rename` / `currency_set` /
  `delete`. (Transactions are the must-have; the rest reuse the same table.)

**Entry fields** (see `audit_log` in §9):
- `actor_user_id` — the authenticated better-auth user who performed it (durable
  key; for display, resolve to their member's name in that group, falling back to
  the user's name).
- `action`, `entity_type`, `entity_id`, `group_id`.
- `occurred_at` — **server** time (UTC), the sort key.
- `summary` — short human-readable line ("Edited '*Dinner*' — amount ฿800 →
  ฿950").
- `metadata` (JSON, optional) — changed fields / before-after snapshot for edits;
  enough to render the line even if the underlying row is later changed or
  hard-deleted (denormalize a label so old entries stay readable).

**Integrity.**
- **Append-only and immutable** — entries are never edited or deleted, including
  when the underlying transaction is soft-deleted (the trail must outlive it).
- Written **server-side in the same DB transaction** as the mutation, in
  `lib/server`, so the log can't drift from what actually happened (no client-
  supplied audit data).

**Visibility (UI).**
- `/groups/[id]/activity` — group activity feed, **sorted by `occurred_at`
  descending**, showing actor, action, entity summary, and relative + absolute
  time. Optional filters by entity type or member.
- Transaction detail page shows that transaction's own history (entries filtered
  to its `entity_id`).
- Visible to **any group member** (consistent with the access model); never
  exposes other groups. Times rendered in the viewer's locale/timezone.

---

## 13. Testing Strategy

- **Unit (Vitest):** debt balance + settlement-minimization algorithm
  (critical — edge cases: rounding, single member, all settled, circular debts).
  Money helpers (**per-currency exponent**: parse/format/round for 0-, 2-, and
  3-decimal currencies; remainder distribution in the currency's smallest unit).
  Validation schemas. **Split resolution for all four modes**, including
  **itemized + service/VAT/discount** — assert per-item rounding, proportional
  charge/discount allocation, discount-before-tax vs after-tax ordering, and that
  `Σ resolved shares == amount_total` exactly (incl. awkward rounding like 3-way
  splits, percentage charges, 100%-off discounts, and a 0-decimal currency like
  JPY).
- **FX conversion (Vitest):** rate math via integer/bignum (no float drift);
  convert-total-then-distribute ties paid and owed to the same
  `amount_total_settlement`; cross-exponent pairs (e.g. CNY→THB, JPY→USD,
  USD→KWD); rate-vs-settlement-total entry derive each other; rate-1 no-op;
  group balances still sum to 0 across mixed-currency transactions.
- **Integration:** transaction create/edit with payer/share invariants,
  including itemized transactions with charges + discounts (round-trip edit
  fidelity). **Audit log:** each create/edit/delete/restore writes exactly one
  entry in the same DB transaction, with correct actor/action/entity; entries are
  never mutated and survive a soft-deleted transaction.
- **E2E (Playwright):** **magic-link registration/login** (intercept the sent
  email / capture the link in a test mailbox, follow it, assert session) and
  **passkey** enrol + login via the virtual authenticator API; recovery path
  (magic-link login then re-enrol a passkey); create group → add tx → settle →
  balances zero out; activity feed shows the actions newest-first with the right
  actor.

---

## 14. Suggested Build Phases

1. **Foundation:** scaffold SvelteKit + TS with **pnpm**; `adapter-vercel`;
   Tailwind; init **shadcn-svelte via its CLI** (`pnpm dlx shadcn-svelte@latest
   init`, which also pulls in `@lucide/svelte`); add base components via the CLI;
   DB + Drizzle; better-auth installed with its Drizzle adapter (auth tables
   migrated); base layout; CI lint/test.
2. **Auth:** better-auth **magic-link plugin** (wire `sendMagicLink` to the
   **Mailgun HTTP API** via a small `lib/server` email helper)
   for register/login/recovery, **+ passkey plugin** (standard mode) enrolled
   after first login; logout; onboarding passkey nudge; settings page to add/
   remove passkeys (multiple devices). No password, no social.
3. **Groups & members:** CRUD, reusable invite links with expiry, accept/assign
   flow, multi-group access.
4. **Transactions:** schema + add/edit/list for spending & transfer; categories;
   validation invariants. Split modes equal/amount/share first, then **itemized
   + service/VAT/discount** (items UI, charge & discount inputs, live breakdown,
   resolution into aggregated shares). Then **multi-currency + manual FX**
   (currency picker, rate/settlement-total entry, convert-then-distribute into
   settlement-currency shares).
5. **Debts:** balance computation, "who should pay", settlement suggestions,
   settle-via-transfer.
6. **Audit log:** write append-only entries inside each mutation (start with
   transactions; extend to member/invite/group actions), plus the
   `/groups/[id]/activity` feed and per-transaction history. (Wire the write
   helper in Phase 4 so no mutation ships unlogged.)
7. **PWA:** manifest, service worker, installability, offline shell.
8. **Polish:** empty states, mobile UX, a11y, e2e tests, perf.

> Phases are independently revisable; reorder as needed.

---

## 15. Glossary

- **Member** — a participant slot in a group's ledger; may be unlinked to any
  user.
- **User** — an authenticated account (one or more passkeys).
- **Balance** — paid minus owed, per member, within a group (settlement currency).
- **Settlement** — a Transfer transaction that reduces outstanding debt.
- **Settlement currency** — the single base currency a group's balances and
  settlements are expressed in; locked after the first transaction.
- **Transaction currency** — the currency a given transaction is entered/split in;
  may differ from the settlement currency.
- **Exchange rate** — manual, per-transaction; settlement-currency units per 1
  unit of the transaction currency (no FX API).
- **Audit log** — append-only, immutable record of who performed which mutation
  (create/edit/delete/…) and when; shown per group, newest first (§12.1).
