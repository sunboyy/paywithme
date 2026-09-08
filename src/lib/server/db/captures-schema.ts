import { isNotNull, isNull, sql } from 'drizzle-orm';
import { pgTable, text, bigint, date, timestamp, index } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';
import { groups } from './groups-schema';
import { transactions } from './transactions-schema';

// Record-later placeholders — CAPTURES (issue #49; PLAN §7.7, §9; ADR-0012).
//
// A Capture says "this expense exists, I'll fill in the details later" in a few
// seconds. It is its OWN entity, NOT a transaction in a draft state: admitting
// drafts into `transactions` would mean relaxing `amount_total`'s NOT NULL and
// §7.4's "payers sum to the total" for EVERY row forever, and giving every
// consumer a `status <> 'draft'` filter to forget (ADR-0012).
//
// ── THE COLUMN LIST IS THE SPEC ──────────────────────────────────────────────
// There is no payer, beneficiary, split-mode, item, or exchange-rate column here,
// and there must never be one. `amount_minor` + `currency` are stored
// UNINTERPRETED: no rate, no conversion, no settlement equivalent (PLAN §7.7
// "Edge cases"). §8 balance math, `/settle`, `/api/v1` and the MCP transaction
// tools never read this table — nothing that computes a balance can see a
// Capture.
//
// ── TIMESTAMP NAMING — THE §7.1 REVERSAL DOES *NOT* APPLY HERE ───────────────
// This is the trap this table is most likely to be misread through. On
// `transactions`, `created_at` is the EDITABLE REAL-WORLD DATE and `occurred_at`
// is the immutable insert time (PLAN §7.1, deliberately reversed). On `captures`
// the real-world date has its own column, `captured_for`, so:
//   - `captured_for` = the real-world day (defaults to today) — the §7.1 role.
//   - `created_at`   = the server insert time, plain and immutable. It is NOT a
//                      real-world date and is NOT user-editable.
// PLAN §9 spells the table exactly this way; there is no `occurred_at` here.
//
// Conventions otherwise mirror `groups-schema.ts` / `receiving-schema.ts`:
// `text('id')` PK generated in-app with `crypto.randomUUID()`, camelCase property
// keys → snake_case columns, nullable timestamps for soft state.

export const captures = pgTable(
	'captures',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		// A Capture REQUIRES a group (PLAN §7.7 "Edge cases"): "I forget which group
		// this was" is deliberately unsolved, because a Capture nobody can see has no
		// deduplication value. Cascade with the group like every other domain row.
		groupId: text('group_id')
			.notNull()
			.references(() => groups.id, { onDelete: 'cascade' }),
		// The author → user.id. NOT NULL with the default `restrict`, exactly like
		// `transactions.created_by`: every Capture is attributed to whoever wrote it
		// (§7.7 "Group-visible"), so a user who authored one can't be deleted out from
		// under it.
		createdBy: text('created_by')
			.notNull()
			.references(() => user.id),
		// The only required content — free text, MEMBER-AUTHORED (CONTEXT.md).
		note: text('note').notNull(),
		// OPTIONAL money: integer minor units of `currency`, stored and read back
		// unchanged. `bigint`/number for the same reason as the ledger's amounts (see
		// `transactions-schema.ts`); NEVER a float.
		amountMinor: bigint('amount_minor', { mode: 'number' }),
		// The code `amount_minor` is denominated in. Deliberately NOT a foreign key to
		// `currencies.code`: a group may delete a custom currency once no TRANSACTION
		// references it (ADR-0014), and an FK here would let a placeholder that the
		// ledger cannot see block that delete — the ledger's rules must not bend
		// around a Capture. The write path validates the code against the group's set;
		// a code may afterwards dangle, the same way `audit_log.entity_id` may.
		currency: text('currency'),
		// The real-world day (§7.1's role, under its own name — see the header). A
		// DATE, not a timestamp: an approximate "which day was this" needs no clock.
		// The authoritative default is the Zod schema's UTC `todayUtc()`; the DB
		// default is only a backstop for a direct insert.
		capturedFor: date('captured_for', { mode: 'string' }).defaultNow().notNull(),
		// THE ONLY LINK INTO THE LEDGER (PLAN §9 note). Stamped on resolve, never
		// cleared by the app: the trail from remembering to recording must survive.
		// `set null` on delete, so a (non-v1) hard delete of the transaction leaves the
		// Capture RESOLVED — `resolved_at` still stands, so it does not silently
		// reappear in the tray — with a dangling link rather than dragging a row that
		// is "never hard-deleted" down with it.
		//
		// A SOFT delete is the opposite case and the one v1 actually has (issue #91).
		// `transactions.deleted_at` touches nothing here, and it must not: the note
		// stays stamped, but it counts as OPEN AGAIN for as long as the transaction it
		// points at is soft-deleted, so it returns to the tray instead of leaving the
		// expense neither on the ledger nor in the queue. Restoring the transaction
		// closes it again. That is a READ-TIME rule — see `openCapturePredicate()` in
		// `lib/server/captures.ts` — which is why nothing on the delete path writes
		// here.
		resolvedTransactionId: text('resolved_transaction_id').references(() => transactions.id, {
			onDelete: 'set null'
		}),
		resolvedAt: timestamp('resolved_at'),
		// Soft-discard (§7.7 "Edge cases"): a Capture may be given up on without being
		// resolved. Soft, never a row delete — a Capture is never hard-deleted.
		discardedAt: timestamp('discarded_at'),
		// SERVER INSERT TIME. See the header: this is NOT the §7.1 real-world date.
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [
		// PLAN §9, verbatim: captures(group_id, resolved_at).
		index('captures_group_id_resolved_at_idx').on(table.groupId, table.resolvedAt),
		// PLAN §9: "partial index on open rows for the count". The unrecorded count
		// sits on `/groups` and the group overview and is recomputed on every page
		// load (§7.7 "Recall"), so it must not scan a group's whole history of
		// already-recorded rows. PARTIAL, because that history only grows while the
		// open set is a queue to empty — the index stays the size of what's actually
		// pending.
		//
		// The predicate is the NEVER-STAMPED arm of "open" —
		// `resolved_at IS NULL AND discarded_at IS NULL`. Both nulls are required: a
		// discarded Capture was never resolved, so `resolved_at IS NULL` alone would
		// keep counting it.
		//
		// It is one of TWO arms since issue #91: a note whose transaction has since
		// been soft-deleted is open again, and no partial index can say that, because
		// the fact lives in another table. That arm is served by the two indexes below
		// instead, and `openCapturePredicate()` in `lib/server/captures.ts` is where
		// the two are joined into one definition.
		//
		// Written as an `sql` template rather than `and(...)`, whose return type is
		// `SQL | undefined` (it collapses when every argument is undefined) and so
		// doesn't fit `.where()`. The emitted predicate is identical.
		index('captures_group_id_open_idx')
			.on(table.groupId)
			.where(sql`(${isNull(table.resolvedAt)} and ${isNull(table.discardedAt)})`),
		// The RE-OPENED arm's other half (issue #91): given a soft-deleted transaction
		// — found through `transactions_group_id_deleted_idx`, which is the small set —
		// this finds the note that points at it. Without it, "is this transaction's note
		// back in the tray?" reads the group's whole recorded history on every page
		// load, which is exactly what the partial index above exists to avoid.
		//
		// Partial on the link being set, so an unresolved note (most of the table, and
		// all of the open queue) is not indexed here at all.
		index('captures_resolved_transaction_id_idx')
			.on(table.resolvedTransactionId)
			.where(isNotNull(table.resolvedTransactionId))
	]
);
