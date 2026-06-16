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
- Multi-currency _settlement_ (a group settles in exactly one currency; only the
  per-transaction entry currency may differ).
- Reporting / charts / analytics.

---

## 2. Decisions (resolved) & Remaining Questions

### Resolved

1. **Money.** **Integer minor units** (no floats); precision **per-currency**
   (see #13), formatted at that currency's decimal places. (See §7.5.)
2. **Split model.** Four modes: **Equal**, **by amount** (exact), **by share**
   (weights), **Itemized** (line items, each with own amount + beneficiaries +
   per-item split). Schema stores resolved per-member amount + the mode + inputs.
   (See §7.2.)
3. **Multiple payers.** Store an explicit `amount_paid` per payer.
4. **Member ↔ user linking.** **Invite link** only; a member is assigned to the
   user **on accepting the invite**. (See §6.2.)
5. **Permissions.** **No restrictions** in v1 — any group member can
   create/edit/delete any transaction and manage members.
6. **Account recovery.** **Via email magic link** — losing all passkeys isn't
   fatal (log in by link, re-enrol). Email is the root of access; no recovery
   codes. Multiple passkeys per account. (See §5.6.)
7. **Offline.** **No offline creation.** Installable + offline shell only; writes
   require connectivity.
8. **Auth library.** **better-auth** with **magic-link plugin** (register / login
   / recovery) **+ passkey plugin** in standard session-required mode (enrolled
   after first login). No password, no social; no passkey-first / `resolveUser`.
   Email via the **Mailgun HTTP API**. (See §3, §5.)
9. **Categories.** **Fixed seeded list** (not user-editable in v1); separate
   Spending/Transfer sets, each a **lucide** icon; **general-purpose**. (See §7.3.)
10. **Currency / FX.** One **settlement currency** per group (base for all debt
    math); a transaction may use a **different currency** with a **manual rate**
    (no FX API), converted to settlement. (See §6.1, §7.5, §7.6.)
11. **Settlement display.** **Simplified suggestions** only (minimized transfers),
    not raw pairwise debts. (See §8.)
12. **Invite links.** **Reusable**, **7-day expiry**, **multiple active per
    group**, with a **revocation UI**. (See §6.2.)
13. **Currency precision.** **Per-currency** exponent, not fixed 2dp (e.g.
    JPY/KRW/VND = 0, THB/USD = 2, KWD/BHD = 3); math/rounding currency-aware.
    (See §7.5.)
14. **Member removal.** **Soft-deactivate**, never hard-delete a member with
    activity; inactive members stay in past transactions/balances but drop from
    new-transaction pickers. (See §6.3.)
15. **Group lifecycle.** Settlement currency **editable only until the first
    transaction**, then **locked**; groups **soft-deleted**, not hard-deleted.
    (See §6.4.)
16. **DB driver / runtime.** Vercel **Node** runtime, **`pg`** driver over Neon's
    pooled URL; migrations use the non-pooled/direct URL. (See §3.)
17. **Manual FX.** Rate **per transaction**, manual, in settlement units per 1
    transaction unit; the settlement total is computed once and stored
    canonically (balances never re-derive a rate). (See §7.6.)
18. **Audit log.** No per-action permissions, so an **append-only**, immutable log
    records actor + action + entity + server timestamp per mutation (priority:
    transactions); shown per group, newest first. (See §12.1.)
19. **Supported currencies.** Fixed seeded **29 fiat currencies** (top 30 by
    market cap from fiatmarketcap.net, **minus BTC** — non-fiat, non-ISO minor
    units); both settlement and entry currency must be from this list. (See §7.5.1.)
20. **Auth method (revised).** **Email magic link** is the baseline: registration
    collects **display name + email**, logs in via an emailed single-use link that
    **verifies the email**; a **passkey** enrolled after first login is the primary
    fast login. Email required + unique. (Supersedes the passkey-first draft.)
    (See §5.)
21. **Rounding tie-break.** Largest-remainder ties go to the **lower `member_id`**
    (ascending), so split/charge/FX distribution is reproducible. (See §7.2.)
22. **Open invite accept.** Accepting **requires a logged-in user** (no guest
    accept); an open link creates a new member named after the accepting user.
    (See §6.2.)
23. **Transaction timestamps.** `created_at` = real-world date, **user-editable /
    backdatable** (sort + display key); `occurred_at` = immutable server insert
    time. (See §7.1.)
24. **Secrets / local dev.** A committed **`.env.example`** documents every env var
    (Neon pooled + direct URLs; `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`,
    `MAILGUN_BASE_URL`, `EMAIL_FROM`; `rpID` / `origin` / `trustedOrigins`). Local
    dev uses a **local Postgres** and **logs the magic-link URL to the console**
    instead of emailing. The user supplies **real Neon + Mailgun credentials** when
    needed (email testing / deploy). (See §3, §5.)
25. **Branding / PWA assets.** The **user provides** the real PWA icons (192/512 +
    maskable) and theme/background colors; the manifest's icon/theme fields are
    filled last, everything else in §11 built ahead. (See §11.)
26. **Display-name capture.** The magic-link plugin doesn't persist a name on
    signup, so it's collected on **`/register`** and written to **`user.name`
    right after the first magic-link verification** (onboarding). (See §5.3.)
27. **FX integer math.** Conversion is a **single scaled-integer, round-half-up**
    expression (rate as 6-dp micro-units), with no intermediate float — see the
    formula in §7.6.
28. **Responsive, mobile-first UI.** **Primarily used on phones**, so every screen
    is **mobile-first and fully responsive**: small-screen first, enhanced for
    tablet/desktop (fluid layouts, Tailwind breakpoints, touch targets,
    bottom-reachable actions). All forms and lists stay usable one-handed; no
    layout requires a desktop viewport. (See §10.)

### Still to decide

- Nothing blocking — all major v1 decisions are resolved. Remaining items are
  build-time fine-tuning (exact copy, final category names, icon swaps,
  per-currency symbol polish), plus the deferred user-supplied inputs in #24–#25
  (real credentials and brand assets), provided when reached.

---

## 3. Tech Stack

| Concern             | Choice                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| Framework           | **SvelteKit** (Svelte 5 runes), SSR via **`adapter-vercel`**                        |
| Hosting             | **Vercel**                                                                          |
| Package manager     | **pnpm**                                                                            |
| Language            | TypeScript                                                                          |
| UI / styling        | **shadcn-svelte** + Tailwind CSS                                                    |
| Icons               | **lucide** (`@lucide/svelte`) — installed by shadcn-svelte init                     |
| PWA                 | `@vite-pwa/sveltekit` (Workbox service worker + manifest)                           |
| Auth                | **better-auth** + **magic-link plugin** (email) + **passkey plugin** (passwordless) |
| Email               | **Mailgun HTTP API** (`mailgun.js`, or plain `fetch`) for magic links               |
| Session             | Managed by better-auth (HTTP-only secure cookie)                                    |
| Database            | **Neon** (serverless Postgres) for prod / local Postgres for dev                    |
| DB driver / runtime | **`pg`** (node-postgres) on Vercel **Node** runtime, pooled URL                     |
| ORM / migrations    | **Drizzle ORM** + drizzle-kit (better-auth uses its Drizzle adapter)                |
| Validation          | Zod (shared client/server schemas)                                                  |
| Money math          | Integer minor units + a small helper (no floats)                                    |
| Testing             | Vitest (unit), Playwright (e2e incl. virtual authenticator)                         |
| Lint/format         | ESLint + Prettier                                                                   |

> **Why these:** SvelteKit gives SSR + PWA + API routes in one app; Drizzle is
> type-safe and migration-friendly; shadcn-svelte matches the styling requirement.
> **better-auth** handles passwordless auth (magic link for signup/recovery,
> passkey for fast login — multiple per account) with a SvelteKit handler + Svelte
> client.
>
> **Note on better-auth:** it owns its auth tables via the Drizzle adapter
> (`user`, `session`, `account`, `verification`, `passkey`) — `verification` backs
> the magic-link tokens; our domain tables (groups, members, transactions)
> reference `user.id`. The passkey plugin runs in **standard session-required
> mode** (a logged-in user adds a passkey), so no `resolveUser` / passkey-first
> wiring is needed. Magic-link delivery uses a `sendMagicLink` callback backed by
> the **Mailgun HTTP API**. (See §5.)
>
> **Runtime & driver (decided):** Vercel **Node** runtime (`adapter-vercel`
> default) with the **`pg`** (node-postgres) driver over Neon's **pooled** URL;
> drizzle-kit migrations use the **non-pooled/direct** URL. (Node keeps better-auth,
> WebAuthn, and a conventional Postgres driver simple; `@neondatabase/serverless`
> is only needed for the unused edge runtime.) Tooling conventions (pnpm,
> shadcn-svelte CLI) live in `CLAUDE.md`; env vars in decision #24 / `.env.example`.

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
    credential** for **registration**, as an always-available login, and as the
    **account-recovery** path.
  - **Passkey** (WebAuthn / FIDO2, better-auth **passkey plugin**) — enrolled
    **after the first login** as the fast, primary day-to-day login on a device.
- **No email/password** module and **no social login**. The email is **verified
  implicitly** by clicking the magic link.
- Because the passkey is added by an already-authenticated user, the plugin runs
  in **standard, session-required mode** — no passkey-first `requireSession:false`
  / `resolveUser` / signed-context mechanism (removing the main auth risk from
  earlier drafts).
- better-auth manages users, sessions, magic-link verification tokens, and passkey
  credentials in its own tables (`user`, `session`, `account`, `verification`,
  `passkey`).
- A SvelteKit catch-all route mounts the better-auth handler
  (`/api/auth/[...all]/+server.ts`); the Svelte client (`createAuthClient` +
  `magicLinkClient` + `passkeyClient`) drives the browser flows.

### 5.2 Setup

- Server: `betterAuth({ database: drizzleAdapter(...), plugins: [
magicLink({ sendMagicLink }), passkey({ rpID, rpName: "Pay with me", origin }) ]
})`. (`rpName` is what the OS passkey prompt shows.)
- `emailAndPassword` is **not** enabled; no social providers.
- **Email delivery (new dependency):** the magic-link plugin's
  `sendMagicLink({ email, url })` callback sends the link via the **Mailgun HTTP
  API** (`POST https://<base>/v3/<domain>/messages`, basic auth `api:<key>`) using
  **`mailgun.js`** or plain `fetch` — no SMTP, so no per-invocation handshake.
  Config via env vars: `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_BASE_URL`
  (`https://api.mailgun.net` US / `https://api.eu.mailgun.net` EU), and
  `EMAIL_FROM` (a verified sender on that domain). Wrap in one small `lib/server`
  email helper so it's swappable. (See §3, §12.)
- Email is **required and unique** per account (`user.email`); it's the identifier
  the magic-link flow matches on and is never exposed across groups (§12).

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

- While authenticated, `authClient.passkey.addPasskey()` creates the credential
  and better-auth stores it against the user.
- Offered right after first login (onboarding nudge) and anytime from `/settings`.
  **Multiple passkeys per account** supported (add a second device).

### 5.5 Login flow (returning users)

- **Primary:** `authClient.signIn.passkey()` — **discoverable / usernameless**
  credentials with conditional UI / autofill; the fast path on an enrolled device.
- **Fallback / new device / lost passkey:** email magic link (§5.3). Both set the
  same better-auth session cookie.

### 5.6 Recovery — via email magic link

- Losing every passkey is **not** fatal: log in with an email magic link and
  re-enrol a passkey. This relies on continued **email account** access — the root
  of account access. No secondary recovery (no recovery codes) in v1.

### 5.7 Session management

- Sessions/cookies are managed by better-auth (HTTP-only, Secure, `SameSite=Lax`).
- In `hooks.server.ts`, resolve the better-auth session and attach
  `event.locals.user` / `event.locals.session` for downstream `load`/actions.

---

## 6. Groups & Members

### 6.1 Model

- **Group**: id, name, **settlement currency** (required; the base for all
  balances and settlements), created_by, timestamps.
- **Member**: belongs to a group; has a display name; **optionally** linked to a
  `user_id` (nullable, → better-auth `user.id`), so you can add people without
  accounts.
- **Access**: granted when the user is linked to at least one member in a group
  (no separate membership table — `members.user_id` is the source of truth); a
  user can access multiple groups.

### 6.2 Member ↔ User linking (Invite link)

A member is a _participant slot_ in a group's ledger, which may or may not map to
a real account holder. v1 uses **invite links only**: a link is **reusable with a
7-day expiry** (shareable with several people, accepted multiple times until it
expires or is revoked), **multiple active per group** (managed via a **revocation
UI**, see §10), and **member-agnostic** — it grants entry to the group, not a
pre-chosen slot, so **the invitee decides how to join at accept time**.

Flow:

1. A group member generates an **invite link** (token), expiring **7 days** after
   creation (default). Multiple links can be active at once.
2. The invitee opens the link. **Accepting always requires a registered,
   logged-in user** — no anonymous/guest accept. If not logged in, they must
   register or log in via passkey first, then continue the accept.
3. If the token is **valid and unexpired**, the invitee is **prompted to choose
   how to join the group**:
   - **Link an existing member** — claim one of the group's **unlinked, active**
     slots (e.g. a placeholder added ahead of time): set
     `members.user_id = currentUser`, keeping its `display_name`. Claimable only
     while still unlinked — a repeat or concurrent claim is rejected (single-use
     per slot).
   - **Join as a new member** — create a **new member** linked to the user, with
     `display_name` defaulting to the accepting **user's name** (editable later).
4. The link stays valid for further accepts until it expires or is revoked — each
   accept is independent and member-agnostic.

Rules:

- Unlinked members still appear in transactions and debt math.
- A user can be linked to members across many groups (multi-group access), but
  **not more than one member in the same group** — enforced on accept (if already
  a member, the accept is a no-op / friendly message).
- Accepting grants that user access to the group.
- Expired (>7 days) or revoked links show a clear error and can't be accepted.
- The member-management screen lists active links with create / copy / **revoke**,
  plus expiry and (optionally) a usage count.

### 6.3 Member lifecycle (removal)

- A member is **soft-deactivated**, not hard-deleted, once they have any activity
  (a payer/share row in any transaction), via a `members.deactivated_at` flag.
- A deactivated member **stays in past transactions and in balance/debt math** —
  the ledger is never rewritten. They simply drop out of pickers when creating or
  editing transactions, and are marked "inactive" in member lists.
- A member with **zero activity** may be hard-deleted (cleanup of a mistyped slot).
- Deactivating does **not** clear outstanding balances; the suggested-settlement
  view still shows what they owe / are owed until settled. (Reactivation is a
  simple flag flip; nice-to-have.)
- If the member was linked to a user, deactivation removes that user's access to
  the group (no active member link remains).

### 6.4 Group lifecycle (currency lock, deletion)

- The **settlement currency** is editable only while the group has **no
  transactions**. After the first transaction it is **locked** — changing it would
  invalidate every stored settlement-currency total and per-transaction rate
  (historical rates can't be re-derived). Surface this in the edit UI. (Per-
  transaction _entry_ currency is always free; only the group's settlement
  currency locks.)
- **Group rename** is always allowed.
- **Deletion is a soft-delete** (`groups.deleted_at`): the group is hidden from
  every member's list and its routes return not-found, but data is retained and
  recoverable. No hard-delete in v1.

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
  - `occurred_at` — the **server timestamp set to now** at row creation;
    **immutable** (never edited, never backdated).
  - `updated_at` — server timestamp, bumped on every edit.
  - _(Note: `created_at` = editable real-world date, `occurred_at` = immutable
    insert time — the reverse of the usual convention. Intentional; keep it
    consistent across schema, queries, and UI.)_
- **Currency & FX (see §7.6):**
  - `currency` — the transaction's entry currency (defaults to the group's
    settlement currency; may differ from it).
  - `exchange_rate` — manual rate, settlement-currency units per **1** unit of
    `currency`. Implicitly `1` (and hidden in the UI) when `currency` ==
    settlement currency.
  - `amount_total_settlement` — `amount_total` converted to settlement minor
    units, computed once and stored as the canonical value the debt engine reads.
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
- **itemized** — see §7.2.1. Broken into line items split independently, then
  per-member amounts aggregated into `transaction_share.amount_owed`.

All modes persist the **resolved `amount_owed`** at the transaction level (source
of truth for debt math) _and_ the inputs (`split_mode`,
`share_weight`/`raw_amount`, and for itemized the item rows) for faithful
re-editing.

**Rounding:** distribute remainders deterministically (largest-remainder) so
resolved shares sum exactly to the total in minor units. **Tie-break:** equal
remainders give the leftover minor unit to the **lower `member_id`** (ascending),
so distribution is fully reproducible and unit-testable. For itemized, round
**within each item** first, then aggregate (each item's shares sum to its amount,
items sum to `amount_total`). The same tie-break applies to charge/discount
allocation (§7.2.3) and FX share distribution (§7.6).

#### 7.2.1 Itemized splitting

An itemized spending is a list of **line items**, each with its own amount and
its own set of beneficiaries + per-item split mode:

- **transaction_item**: `(id, transaction_id, label, amount)` — one line of the
  receipt (e.g. "Pizza", "Beers"). `items_subtotal = Σ item.amount`.
- **transaction_item_share**: `(item_id, member_id, amount_owed, split_mode,
share_weight?, raw_amount?)` — who shares _this item_ and how it's split
  (equal/amount/share per item).

#### 7.2.2 Charges & discounts: service charge, VAT, discount

Real bills add **service charge** and **VAT** _on top of_ item prices
("exclusive"), and sometimes a **discount** (coupon/promo/bill-level reduction).
All **vary per spending** with **no group default** — entered fresh each time.
Model them as per-transaction "charge" rows (a discount is a negative-effect
charge):

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
   share (largest-remainder rounding so allocations sum exactly to that total); a
   discount the same way (negative), reducing each share proportionally to
   consumption.
4. Each member's owed (**transaction currency**) = subtotal share + allocated
   charges − allocated discounts. These sum exactly to `amount_total`.
5. Payers remain at the transaction level (who paid, net of discount), also in the
   transaction currency.
6. **Currency conversion (§7.6):** if the transaction currency differs from
   settlement, convert each member's owed and each payer's paid (control sum = the
   rounded settlement total, largest-remainder so they tie out) → the
   **settlement-currency** values in `transaction_share.amount_owed` /
   `transaction_payer.amount_paid_settlement` that §8 reads. A no-op when the
   currencies match (rate 1).

Why this shape: the debt engine (§8) reads only the aggregated `transaction_share`
rows (always in the settlement currency), so balance/settlement math is
**unchanged** by itemization, charges, discounts, **or FX** — they're purely an
input/detail layer that derives the settlement-currency shares.

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

| Category       | lucide icon       |
| -------------- | ----------------- |
| Food & Drink   | `utensils`        |
| Groceries      | `shopping-basket` |
| Transportation | `car`             |
| Rent / Housing | `house`           |
| Utilities      | `zap`             |
| Entertainment  | `clapperboard`    |
| Shopping       | `shopping-bag`    |
| Travel         | `plane`           |
| Health         | `heart-pulse`     |
| Other          | `shapes`          |

**Transfer categories** (name → lucide icon):

| Category        | lucide icon |
| --------------- | ----------- |
| Debt settlement | `handshake` |
| Cash            | `banknote`  |
| Bank transfer   | `landmark`  |
| Other           | `shapes`    |

- The transaction form shows only the categories whose `applies_to` matches the
  selected transaction type.

**Category meanings** (to keep the overlapping ones distinct in a flat list):

- **Travel** = trip-specific costs: accommodation, flights/long-distance tickets,
  tours/activities, baggage, travel insurance.
- **Transportation** = everyday local movement (bus/metro/taxi/ride-share, fuel,
  parking, tolls), including local rides _while_ on a trip.
- **Food & Drink** = all meals, including during a trip.

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

- Stored everywhere as **integer minor units** — **no floating point**. All
  arithmetic (splits, balances, settlements) is done in minor units.
- **Precision is per-currency, not a fixed 2dp.** Each currency has a minor-unit
  **exponent** (JPY/KRW/VND = 0, THB/USD/EUR = 2, KWD/BHD/TND = 3); scale factor
  `10^exponent`, not a hardcoded ×100.
  - Keep a small **currency table/constant** mapping code → { exponent, symbol,
    display format }, seeded from §7.5.1. Exponents follow ISO 4217 minor units.
  - Each amount uses **its own** currency's exponent: entry amounts the
    transaction currency's, balances/settlements the group settlement currency's.
    The settlement currency locks after the first transaction (§6.4), so its
    exponent never changes under existing data.
- A `lib/money` helper is **currency-aware**: parse (string→minor), format
  (minor→display at the right dp + symbol), and largest-remainder split
  distribution (remainder in the currency's smallest unit). All split/charge/
  discount rounding (§7.2.3) uses this.
- **Two currencies are in play** (see §7.6): entry/split use the **transaction
  currency**'s exponent, then resolved amounts convert to the group's
  **settlement currency** (its exponent) for balance/debt math. The money helper
  is told which currency it operates in for every parse/format/round.

#### 7.5.1 Supported currencies (v1)

**Fixed, seeded list of 29 fiat currencies** (top 30 by market cap from
fiatmarketcap.net, **excluding BTC** — non-fiat, and its 8-decimal non-ISO-4217
minor units don't fit the exponent model). Both the group **settlement currency**
and a transaction's **entry currency** must be one of these. Seeded via migration;
the `exponent` column drives all minor-unit math (§7.5).

| #   | Code | Currency           | Exponent | Symbol |
| --- | ---- | ------------------ | -------- | ------ |
| 1   | CNY  | Chinese Yuan       | 2        | CN¥    |
| 2   | USD  | US Dollar          | 2        | $      |
| 3   | EUR  | Euro               | 2        | €      |
| 4   | JPY  | Japanese Yen       | 0        | ¥      |
| 5   | GBP  | Pound Sterling     | 2        | £      |
| 6   | KRW  | South Korean Won   | 0        | ₩      |
| 7   | HKD  | Hong Kong Dollar   | 2        | HK$    |
| 8   | TWD  | New Taiwan Dollar  | 2        | NT$    |
| 9   | CAD  | Canadian Dollar    | 2        | CA$    |
| 10  | RUB  | Russian Ruble      | 2        | ₽      |
| 11  | BRL  | Brazilian Real     | 2        | R$     |
| 12  | CHF  | Swiss Franc        | 2        | CHF    |
| 13  | MXN  | Mexican Peso       | 2        | MX$    |
| 14  | INR  | Indian Rupee       | 2        | ₹      |
| 15  | SAR  | Saudi Riyal        | 2        | SAR    |
| 16  | AED  | UAE Dirham         | 2        | AED    |
| 17  | PLN  | Polish Zloty       | 2        | zł     |
| 18  | THB  | Thai Baht          | 2        | ฿      |
| 19  | SGD  | Singapore Dollar   | 2        | S$     |
| 20  | VND  | Vietnamese Dong    | 0        | ₫      |
| 21  | MYR  | Malaysian Ringgit  | 2        | RM     |
| 22  | TRY  | Turkish Lira       | 2        | ₺      |
| 23  | IDR  | Indonesian Rupiah  | 2        | Rp     |
| 24  | SEK  | Swedish Krona      | 2        | kr     |
| 25  | ILS  | Israeli New Shekel | 2        | ₪      |
| 26  | NOK  | Norwegian Krone    | 2        | kr     |
| 27  | CZK  | Czech Koruna       | 2        | Kč     |
| 28  | PHP  | Philippine Peso    | 2        | ₱      |
| 29  | ZAR  | South African Rand | 2        | R      |

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
transaction currency** (§7.2–§7.2.3), producing each member's owed + each payer's
paid in transaction-currency minor units. Then a single conversion step:

1. Compute the **canonical settlement total**:
   `amount_total_settlement = convert(amount_total)` (one rounded value).
2. Distribute that settlement total across members in proportion to their
   transaction-currency owed, using **largest-remainder** rounding → each
   `transaction_share.amount_owed` (settlement minor units). Sums to
   `amount_total_settlement` exactly.
3. Do the same for payers → `transaction_payer.amount_paid_settlement`.

Converting once at the total then distributing (rather than converting each share
independently) ties paid and owed to the same settlement total, so group balances
always sum to 0. §8 reads **only** these settlement-currency amounts — never rates
or foreign amounts — so balances and simplified settlements are unchanged.

**UX (entry).** See §10 — pick the currency (defaults to the group's); if it
differs, enter **either** the rate **or** the settlement-equivalent total (the
other derived as `rate = settlement_total / txn_total`), with a live converted
total shown. Stored canonical = rate + computed `amount_total_settlement`.

**Display.** Transaction lists/detail show the **original** amount + currency
(e.g. ¥200) with the settlement equivalent (฿970) as secondary text. Balances,
"who should pay", and settlement suggestions show **only** the settlement
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

Sort members by balance ascending; the most negative should pay first. Surface
this prominently.

### 8.3 Suggested settlements (simplified — minimize transfers)

v1 shows **simplified suggestions only** (a minimized set of transfers), not raw
pairwise debts. Greedy debt-simplification:

1. Split members into creditors (balance > 0) and debtors (balance < 0).
2. Repeatedly match the largest debtor with the largest creditor; suggest a
   transfer of `min(|debtor|, creditor)`; reduce both.
3. Continue until all balances ~0.

This yields a minimal set of "X pays Y amount Z" suggestions for the settle screen.

### 8.4 Settle action

- From a suggested settlement, prefill a **Transfer** transaction (payer = debtor,
  recipient = creditor, amount, category = "Debt settlement").
- On save it's a normal transaction, so balances recompute and the suggestion list
  shrinks.

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
invites          (id, group_id, token,                   -- member-agnostic link
                  expires_at, revoked_at?, created_by, created_at)  -- reusable + 7-day
                  -- expiry; invitee picks link-existing vs create-new at accept (§6.2)

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
  (source of truth for §8); for itemized it's derived from
  `transaction_item_shares` + `transaction_charges` (the editable inputs).
- "One member per user per group" enforced by
  `unique(members.group_id, members.user_id)` (where `user_id` not null).
- `audit_log` is **append-only**, written in the same DB transaction as the
  mutation; `summary` is denormalized so entries stay readable even if the entity
  later changes or is hard-deleted (§12.1).

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
/invite/[token]           Accept an invite link (link an existing member or
                          create a new one; grant access)
```

UI building blocks (shadcn-svelte): Button, Card, Dialog, Drawer/Sheet (mobile
add-transaction), Form + Input + Select, Tabs (spending/transfer), Avatar,
Badge, Table/list, Toast, Separator, Alert Dialog (destructive confirmations).
Mobile-first layout.

**Destructive actions require explicit confirmation.** Any action that destroys,
hides, or revokes (remove/deactivate a member, soft-delete a group, revoke an
invite link, delete/restore a transaction) must be guarded by a confirmation
step — a shadcn **Alert Dialog** naming the specific target ("Remove _Alex_?")
with a clearly-labelled, visually-distinct (destructive-variant) confirm button
and a Cancel — so a single mis-tap can't trigger it. Confirmation is a
JS-progressive-enhancement layer: with JS the dialog gates the submit; **without
JS the underlying real form action still works** (the server is the source of
truth and re-validates). It's a UX guard, not an authz control — authorization is
still the §12 membership check, and the change is still recorded in the audit log
(§12.1).

**Self-affecting actions must not strand the user.** When an action removes the
acting user's OWN access to the area they're on — most notably **removing the
member linked to yourself** (which revokes your group access per §6.3) — the
server redirects them somewhere they still belong (e.g. `/groups`) instead of
re-rendering a now-inaccessible page as a confusing "not found".

**Currency & FX (all transaction types):** a currency picker defaulting to the
group's; choosing a **different** currency reveals an FX field (enter rate _or_
settlement-equivalent total, the other derived; live conversion shown, e.g. "¥200
→ ฿970"). Hidden when the transaction is in the settlement currency. (§7.6)

**Itemized transaction form:** a repeatable list of item rows (label, amount,
beneficiaries + per-item split), plus a charges section (**service charge**,
**VAT**, **discount** — each percent or absolute, with order/placement) and a
**live computed breakdown** (items subtotal → ± discount → + service → + VAT →
total, plus each member's resolved share) so the user sees who owes what before
saving. Rates/discounts entered per spending (no saved defaults). All item/charge
amounts are in the **transaction currency**; the breakdown also shows the
settlement-converted total for a foreign currency.

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
  connectivity. The SW gives an installable app + offline shell and may cache
  loaded data for read-only viewing, but offline creating/editing is out of scope.
  Show a clear "you're offline" state that disables write actions.

### 11.1 PWA & auth sessions

PWA caching plus passkey/cookie sessions has specific pitfalls — SW-config +
session-handling rules; none change the data model.

- **Never cache authenticated responses in the service worker.** The classic PWA
  auth leak: a cached SSR page or `/api` response served to a different (or
  logged-out) user exposes private data. Workbox config:
  - **Precache only static/build assets** (JS, CSS, icons, fonts).
  - **NetworkOnly** for navigations and all data / `/api/**` (incl. `/api/auth/**`)
    routes — no `StaleWhileRevalidate` on personalized content.
  - The precached HTML shell must be **auth-agnostic** (no server-rendered user
    data); session-gated data is always fetched from the network, never the SW.
- **iOS standalone has a separate cookie/storage jar.** An installed iOS PWA
  historically doesn't share cookies with Safari, so a browser login doesn't carry
  into the app — the user must authenticate _inside_ the installed PWA. The passkey
  lives in the platform keychain and is still available; only the **session
  cookie** is siloed. Document this so it isn't mistaken for a bug.
- **Magic links open in the default browser, not the installed PWA.** The link
  launches Safari/Chrome, so the cookie lands in the _browser's_ jar — on iOS not
  the PWA's (above). So prefer **passkey login inside the installed app**, treating
  magic link as the browser / new-device / recovery path. Make the magic-link
  landing page work standalone, and after verifying, guide the user to enrol a
  passkey so later logins happen in-app.
- **Treat auth state as server-driven; handle 401 gracefully.** A PWA can stay
  open for days while the cookie expires under it. Never assume "logged in" from
  cached UI: on any `401`, clear client state and route to login. Session
  validation happens per request in `hooks.server` / `load`, never from SW cache.
- **WebAuthn secure context + RP ID.** `rpID` must match the production origin (and
  `localhost` for dev) and must **not** be hardcoded to a Vercel preview URL, or
  standalone registration/auth breaks. (See §12.)
- **Cookie attributes.** better-auth defaults (httpOnly, Secure, `SameSite=Lax`)
  are correct; everything is same-origin, so don't loosen to `SameSite=None`.
- **SW update vs. stale client code.** On deploy a stale SW can keep serving old JS
  that calls changed auth endpoints. Use prompt-to-reload (or controlled
  `skipWaiting`) so auth flows don't break across versions.

---

## 12. Security & Privacy

- Cookies/sessions handled by better-auth (HTTP-only, Secure, SameSite).
- **PWA session/caching rules: see §11.1** (never cache authenticated responses;
  treat auth state as server-driven, handling `401` by re-authenticating).
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
  any user with access to a group can create/edit/delete that group's transactions
  and members. The single enforced check is that the requesting user has access to
  the group (via a linked member). Enforce in `lib/server`.
- Don't leak member emails to other groups.
- **Accountability via audit log (§12.1):** every create/edit/delete records
  _who_ and _when_.

### 12.1 Audit log

With no per-action permissions, the audit log is the safety mechanism: it makes
every change **attributable** and **reviewable**, even though it doesn't prevent
the change.

**What's recorded.** One append-only entry per mutating action:

- **Transactions** (priority): `create`, `edit`, `delete` (soft-delete),
  `restore`.
- Also recommended for v1 (same mechanism): member `add` / `deactivate` /
  `reactivate`, invite `create` / `revoke`, group `rename` / `currency_set` /
  `delete`. (Transactions are the must-have; the rest reuse the same table.)

**Entry fields** (see `audit_log` in §9):

- `actor_user_id` — the authenticated user who performed it (durable key; for
  display, resolve to their member's name in that group, else the user's name).
- `action`, `entity_type`, `entity_id`, `group_id`.
- `occurred_at` — **server** time (UTC), the sort key.
- `summary` — short human-readable line ("Edited '_Dinner_' — amount ฿800 →
  ฿950").
- `metadata` (JSON, optional) — changed fields / before-after snapshot, enough to
  render the line even if the underlying row later changes or is hard-deleted
  (denormalize a label so old entries stay readable).

**Integrity.**

- **Append-only and immutable** — never edited or deleted, even when the
  underlying transaction is soft-deleted (the trail must outlive it).
- Written **server-side in the same DB transaction** as the mutation, in
  `lib/server`, so it can't drift from what happened (no client-supplied data).

**Visibility (UI).**

- `/groups/[id]/activity` — group feed **sorted by `occurred_at` descending**,
  showing actor, action, entity summary, and relative + absolute time. Optional
  filters by entity type or member.
- Transaction detail shows that transaction's own history (entries filtered to its
  `entity_id`).
- Visible to **any group member**; never exposes other groups. Times rendered in
  the viewer's locale/timezone.

---

## 13. Testing Strategy

- **Unit (Vitest):** debt balance + settlement-minimization algorithm (critical —
  edge cases: rounding, single member, all settled, circular debts). Money helpers
  (**per-currency exponent**: parse/format/round for 0-, 2-, 3-decimal currencies;
  remainder in the smallest unit). Validation schemas. **Split resolution for all
  four modes**, incl. **itemized + service/VAT/discount** — assert per-item
  rounding, proportional charge/discount allocation, discount-before- vs after-tax
  ordering, and `Σ resolved shares == amount_total` exactly (incl. 3-way splits,
  percentage charges, 100%-off discounts, a 0-decimal currency like JPY).
- **FX conversion (Vitest):** integer/bignum rate math (no float drift);
  convert-total-then-distribute ties paid and owed to the same
  `amount_total_settlement`; cross-exponent pairs (CNY→THB, JPY→USD, USD→KWD);
  rate-vs-settlement-total entry derive each other; rate-1 no-op; balances still
  sum to 0 across mixed-currency transactions.
- **Integration:** transaction create/edit with payer/share invariants, incl.
  itemized with charges + discounts (round-trip edit fidelity). **Audit log:**
  each create/edit/delete/restore writes exactly one entry in the same DB
  transaction with correct actor/action/entity; entries are never mutated and
  survive a soft-deleted transaction.
- **E2E (Playwright):** **magic-link registration/login** (capture the link in a
  test mailbox, follow it, assert session) and **passkey** enrol + login via the
  virtual authenticator API; recovery path (magic-link login then re-enrol);
  create group → add tx → settle → balances zero out; activity feed shows actions
  newest-first with the right actor.

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
   validation invariants. Split modes equal/amount/share first, then \*\*itemized
   - service/VAT/discount** (items UI, charge & discount inputs, live breakdown,
     resolution into aggregated shares). Then **multi-currency + manual FX\*\*
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
