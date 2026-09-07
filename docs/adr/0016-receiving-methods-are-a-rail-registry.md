# Receiving methods are a rail registry, and write no audit row

Users record their own **Receiving methods** (PLAN §17) so debtors don't have to
ask for bank details in a group chat. Two decisions here would surprise a reader
of the code, so they are recorded rather than left to be inferred.

## The rail is a registry entry, not an enum value

A receiving method stores `rail` (text) + `details` (jsonb), and a code registry
in `lib/server/payout-rails/` maps each rail id to its Zod schema, its display
formatter and, later, its QR encoder. The obvious alternative — a
`promptpay | bank_account | other` enum — was rejected as Thailand-locked.

The evidence that the variation is real, not speculative: **QR-with-amount has no
universal encoding.** Thailand and Brazil use EMVCo Merchant-Presented Mode (Thai
QR, PIX BR Code); the EU uses EPC069-12, an eleven-line plain-text payload that
is IBAN-only, EUR-only and not EMVCo at all; India uses a `upi://` URI. These are
mutually unintelligible, so a QR generator is per-country by construction, and so
is the field schema it reads from. Supporting a second country under an enum
means a migration and a rewrite of every `switch`; under the registry it is one
new entry and no migration.

The registry is **code, not a seeded table** — deliberately unlike the currencies
design (ADR-0014). Currencies need a table because _groups define their own_;
rails are only ever shipped by us, so a typed map is enough and gives per-rail Zod
schemas for free. `th_promptpay` is one entry beside `th_bank_account` and is not
privileged anywhere in the code.

**Consequence for QR:** the first task of the QR issue is a spike, not a build —
confirm against real banking apps that an account-number-proxy Thai QR scans
cross-bank. If only the mobile-number proxy works, QR serves only the users
willing to publish a phone number, which changes the feature's priority. A QR
that silently fails to scan is worse than no QR, because the payer discovers it
at the moment they are trying to pay.

> **Superseded by ADR-0017.** The spike ran (#82): the account-number proxy is
> rejected outright, and the encoder belongs to `th_promptpay` over the proxy
> already stored there. `th_bank_account` gets no encoder — a result, not a gap.

## Changing a receiving method writes no audit row

`CLAUDE.md` requires every mutation to write an append-only `audit_log` row in the
same transaction. Receiving methods are the deliberate exception.

`audit_log` rows are **group-scoped** (`group_id`) and **readable by every member
of that group** via `/groups/[id]/activity` (PLAN §12.1). A receiving method
belongs to a _user_, not a group, so there is no correct `group_id` to write.
Fanning an entry out to every group the user belongs to would broadcast
"Surawich changed their bank account" into eight activity feeds — a privacy leak
and a category error. The audit log exists to make _ledger_ mutations
attributable, and this feature deliberately never touches the ledger: no
transaction records which receiving method was used, and balances gain no fields.

A separate user-level audit stream, visible only to its owner, is a reasonable
future security feature. It is a second audit system, so it is not v1.

**Do not "fix" the missing audit write.** It is the decision, not an omission.
