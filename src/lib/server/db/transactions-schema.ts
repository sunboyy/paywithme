import {
	pgTable,
	text,
	timestamp,
	integer,
	bigint,
	numeric,
	index,
	primaryKey
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema';
import { groups, members } from './groups-schema';
import { currencies } from './currencies-schema';

// Transaction / ledger domain schema (task 4.2; PLAN §9, §7.6, §8, §12.1).
//
// SCHEMA-ONLY: tables + indexes/constraints + the generated SQL migration. No
// CRUD, no Zod validation (4.4), no categories seed (4.3 fills the table created
// here), no audit-write helper (4.6), no routes/UI, no business logic. The
// conventions mirror the hand-authored `groups-schema.ts` / `currencies-schema.ts`:
//   - `text('id')` PKs generated in-app with `crypto.randomUUID()` (the app owns
//     identity, consistent with the text `user.id` FKs these tables reference).
//   - camelCase property keys → snake_case column names.
//   - `timestamp(...).defaultNow().notNull()` for server-set timestamps; nullable
//     timestamps for soft-delete.
//   - junction tables keyed by a composite PK where natural.
//
// ── Column-type decisions (documented per task) ──────────────────────────────
// MONEY = integer minor units, stored as Postgres `bigint` via Drizzle's
//   `bigint(..., { mode: 'number' })`. Task 4.1 (`money.ts`) fixed minor units as
//   plain JS `number`, exact for integers up to `Number.MAX_SAFE_INTEGER` (2^53−1),
//   which dwarfs any realistic group expense. `bigint` is the safe DB type for a
//   value that can exceed a 32-bit `integer`, and `mode: 'number'` keeps it a JS
//   `number` end-to-end (no `bigint` serialization friction) — identical to the
//   precedent in `rate-limit-schema.ts` (`last_request`). NEVER a float: money is
//   integer minor units everywhere (CLAUDE.md).
// EXCHANGE_RATE is NOT minor units — it's a decimal rate (settlement units per 1
//   txn unit, §7.6). Stored as `numeric(18, 6)` exactly as §7.6 pins ("Store the
//   rate as `numeric(18,6)`, never as binary float"). Drizzle returns `numeric`
//   as a string by default; the conversion math (§7.6) scales it with integer
//   arithmetic, never a JS float.
// ENUM-LIKE columns (`type`, `split_mode`, charge `kind`/`mode`/`base`,
//   `applies_to`, audit `action`/`entity_type`) are `text`, NOT `pgEnum`. The
//   codebase uses zero `pgEnum` so far — `currencies`, `groups`, etc. all use
//   `text` — so `text` keeps the schema consistent and avoids the migration churn
//   of altering a DB enum when a value set grows (e.g. adding `tip`). The value
//   sets are the authoritative constraint at the Zod layer (task 4.4); a comment
//   on each column documents the allowed set.
//
// ── Timestamp naming on `transactions` (PLAN §7.1 — DELIBERATELY REVERSED) ─────
// This is the reverse of the usual convention and is pinned by CLAUDE.md:
//   - `created_at` = the REAL-WORLD date the transaction took place. USER-EDITABLE,
//     may be backdated; defaults to now on first entry. This is the date shown and
//     sorted in lists.
//   - `occurred_at` = the SERVER timestamp set to now at row creation; IMMUTABLE
//     (`defaultNow().notNull()`, never updated by the app). It is the stable
//     insert-time / tie-break sort key.
//   - `updated_at` = server timestamp bumped on every edit.
//   - `deleted_at` = nullable soft-delete.
// `audit_log.occurred_at` carries the SAME immutable-insert-time meaning (server
// UTC sort key), consistent with the `occurred_at` semantics above.
//
// ── onDelete semantics (preserve ledger history, mirroring groups-schema) ──────
//   - `created_by` / `actor_user_id` → user.id is NOT NULL with the default
//     `restrict` (no `onDelete`): a user who authored history can't be deleted out
//     from under it. Authorship is durable.
//   - `*.group_id` / `transaction_id` / `item_id` / `category_id` use
//     `onDelete: 'cascade'` so the dependent ledger rows are removed with their
//     parent on a real (non-v1) delete; v1 uses soft-delete (`deleted_at`).
//   - `member_id` → members.id uses `onDelete: 'cascade'` (a member's payer/share
//     rows go with the member on a hard delete; v1 soft-deactivates instead).
//   - `transactions.category_id` → categories.id is `restrict` (default): a
//     category in use can't be removed; categories are a fixed seeded list (§9).

// ── categories (id, name, icon, applies_to) ──────────────────────────────────
// Table definition only. The fixed seed rows are DEFERRED to task 4.3 — this task
// creates an empty table so `transactions.category_id` has a FK target. Categories
// are not user-editable in v1 (§9 / §10.9): a fixed seeded list.
export const categories = pgTable('categories', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull(),
	// Icon identifier (e.g. a lucide icon name). Resolved to a glyph in the UI.
	icon: text('icon').notNull(),
	// Constrained value set: 'spending' | 'transfer' (text, validated at the Zod
	// layer in 4.4). Determines which transaction `type` may use the category.
	appliesTo: text('applies_to').notNull(),
	// Display order WITHIN an `applies_to` set (PLAN §7.3): the transaction form
	// shows only the categories whose `applies_to` matches the selected type, in
	// this order. Canonical values live in `src/lib/categories.ts` (seed source).
	sortOrder: integer('sort_order').notNull()
});

// ── transactions ─────────────────────────────────────────────────────────────
export const transactions = pgTable(
	'transactions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		groupId: text('group_id')
			.notNull()
			.references(() => groups.id, { onDelete: 'cascade' }),
		// Constrained value set: 'spending' | 'transfer' (text; validated in 4.4).
		type: text('type').notNull(),
		title: text('title').notNull(),
		// → categories.id. Restrict on delete (category is a fixed seeded list).
		categoryId: text('category_id')
			.notNull()
			.references(() => categories.id),
		// Money: minor units of THIS txn's currency (§7.6). bigint/number.
		amountTotal: bigint('amount_total', { mode: 'number' }).notNull(),
		// Entry currency code → currencies.code (defaults to group settlement, §7.6).
		currency: text('currency')
			.notNull()
			.references(() => currencies.code),
		// Settlement units per 1 txn unit (§7.6); 1 when txn currency == settlement.
		// numeric(18,6), NOT a float, NOT minor units. String in JS via Drizzle.
		exchangeRate: numeric('exchange_rate', { precision: 18, scale: 6 }).notNull(),
		// Canonical settlement total: amount_total converted at exchange_rate, in
		// SETTLEMENT-currency minor units (§7.6). The only total §8 reads.
		amountTotalSettlement: bigint('amount_total_settlement', { mode: 'number' }).notNull(),
		// Constrained value set: 'equal' | 'amount' | 'share' | 'itemized' (text).
		splitMode: text('split_mode').notNull(),
		// Author → user.id. NOT NULL + default restrict (durable authorship).
		createdBy: text('created_by')
			.notNull()
			.references(() => user.id),
		// IMMUTABLE server insert time (§7.1). NOTE the reversed naming: this is NOT
		// the real-world date — that's `created_at` below.
		// `precision: 3` (millisecond) is DELIBERATE (§16.4): this column is the
		// same-day keyset tie-break, and the opaque pagination cursor round-trips it
		// through JS `Date.toISOString()` (millisecond resolution). Postgres's default
		// `timestamp` is MICROSECOND, so `defaultNow()`'s sub-millisecond entropy would
		// be truncated by the cursor — a concurrently-inserted row landing in that lost
		// sub-ms window could be silently skipped across a page boundary. Quantizing the
		// stored value to millisecond makes it round-trip losslessly; ms is still ample
		// to order distinct inserts (the `id` tie-break covers exact ms collisions).
		occurredAt: timestamp('occurred_at', { precision: 3 }).defaultNow().notNull(),
		// REAL-WORLD transaction date (§7.1). User-editable / backdatable; defaults
		// to now on first entry; the date shown and sorted in lists. `precision: 3`
		// for the same §16.4 cursor round-trip reason as `occurred_at` (it's the
		// primary keyset sort key); a real-world date needs nowhere near sub-ms anyway.
		createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
		// Bumped on every edit.
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
		// Soft-delete (§9): nullable.
		deletedAt: timestamp('deleted_at')
	},
	(table) => [
		// PLAN §9: transactions(group_id, occurred_at). Group ledger listing.
		index('transactions_group_id_occurred_at_idx').on(table.groupId, table.occurredAt),
		// PERF (task 8.5): the group transaction list (`listTransactions`) filters on
		// `group_id` and sorts NEWEST-FIRST by `created_at DESC, occurred_at DESC` — the
		// §7.1 real-world display/sort date, NOT `occurred_at`. The §9 index above is keyed
		// on `occurred_at`, so it can't serve that sort; a group's whole ledger had to be
		// sorted on every list load. This composite index matches the list's WHERE + ORDER
		// BY exactly (group_id, then created_at DESC, occurred_at DESC tie-break), so the
		// feed becomes an index scan instead of a filter-then-sort.
		index('transactions_group_id_created_at_idx').on(
			table.groupId,
			table.createdAt.desc(),
			table.occurredAt.desc()
		)
	]
);

// ── transaction_payers — who paid, keyed by (transaction_id, member_id) ───────
export const transactionPayers = pgTable(
	'transaction_payers',
	{
		transactionId: text('transaction_id')
			.notNull()
			.references(() => transactions.id, { onDelete: 'cascade' }),
		memberId: text('member_id')
			.notNull()
			.references(() => members.id, { onDelete: 'cascade' }),
		// Input: txn-currency minor units (§7.6). bigint/number.
		amountPaid: bigint('amount_paid', { mode: 'number' }).notNull(),
		// RESOLVED settlement-currency minor units — what §8 reads. bigint/number.
		amountPaidSettlement: bigint('amount_paid_settlement', { mode: 'number' }).notNull()
	},
	(table) => [
		// Composite PK: one payer row per (transaction, member).
		primaryKey({ columns: [table.transactionId, table.memberId] }),
		// PLAN §9: transaction_payers(transaction_id).
		index('transaction_payers_transaction_id_idx').on(table.transactionId)
	]
);

// ── transaction_shares — resolved/aggregated per-member owed (source for §8) ──
export const transactionShares = pgTable(
	'transaction_shares',
	{
		transactionId: text('transaction_id')
			.notNull()
			.references(() => transactions.id, { onDelete: 'cascade' }),
		memberId: text('member_id')
			.notNull()
			.references(() => members.id, { onDelete: 'cascade' }),
		// RESOLVED settlement-currency minor units, aggregated (§8). bigint/number.
		amountOwed: bigint('amount_owed', { mode: 'number' }).notNull(),
		// Optional txn-currency inputs preserved for re-edit (non-itemized splits):
		// the weight for a 'share' split. Nullable.
		shareWeight: integer('share_weight'),
		// The raw txn-currency minor-unit input for an 'amount' split. Nullable.
		rawAmount: bigint('raw_amount', { mode: 'number' })
	},
	(table) => [
		// Composite PK: one share row per (transaction, member).
		primaryKey({ columns: [table.transactionId, table.memberId] }),
		// PLAN §9: transaction_shares(transaction_id).
		index('transaction_shares_transaction_id_idx').on(table.transactionId)
	]
);

// ── transaction_items (itemized split only) ──────────────────────────────────
export const transactionItems = pgTable(
	'transaction_items',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		transactionId: text('transaction_id')
			.notNull()
			.references(() => transactions.id, { onDelete: 'cascade' }),
		label: text('label').notNull(),
		// Item amount: txn-currency minor units. bigint/number.
		amount: bigint('amount', { mode: 'number' }).notNull(),
		// Display / application order within the transaction.
		sortOrder: integer('sort_order').notNull()
	},
	(table) => [
		// PLAN §9: transaction_items(transaction_id).
		index('transaction_items_transaction_id_idx').on(table.transactionId)
	]
);

// ── transaction_item_shares — per-item resolved owed + per-item inputs ────────
export const transactionItemShares = pgTable(
	'transaction_item_shares',
	{
		itemId: text('item_id')
			.notNull()
			.references(() => transactionItems.id, { onDelete: 'cascade' }),
		memberId: text('member_id')
			.notNull()
			.references(() => members.id, { onDelete: 'cascade' }),
		// Resolved owed for this item (txn-currency minor units). bigint/number.
		amountOwed: bigint('amount_owed', { mode: 'number' }).notNull(),
		// Per-item split mode: 'equal' | 'amount' | 'share' (text; validated in 4.4).
		splitMode: text('split_mode').notNull(),
		// Optional per-item inputs preserved for re-edit. Nullable.
		shareWeight: integer('share_weight'),
		rawAmount: bigint('raw_amount', { mode: 'number' })
	},
	(table) => [
		// Composite PK: one row per (item, member).
		primaryKey({ columns: [table.itemId, table.memberId] }),
		// PLAN §9: transaction_item_shares(item_id).
		index('transaction_item_shares_item_id_idx').on(table.itemId)
	]
);

// ── transaction_charges — service / vat / discount (/tip) ─────────────────────
export const transactionCharges = pgTable(
	'transaction_charges',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		transactionId: text('transaction_id')
			.notNull()
			.references(() => transactions.id, { onDelete: 'cascade' }),
		// Constrained value set: 'service' | 'vat' | 'discount' | 'tip' (text). The
		// sign of the effect is derived from the kind (discount subtracts).
		kind: text('kind').notNull(),
		// Constrained value set: 'percent' | 'absolute' (text). For 'percent',
		// `value` is basis points (bps); for 'absolute', minor units.
		mode: text('mode').notNull(),
		// POSITIVE magnitude; sign is derived from `kind`. For 'percent' this is bps
		// (an integer), for 'absolute' it is minor units — both fit bigint/number.
		value: bigint('value', { mode: 'number' }).notNull(),
		// Constrained value set: 'items_subtotal' | 'running_total' (text). The base
		// a percent charge applies to.
		base: text('base').notNull(),
		// Application order (e.g. discount-before/after-tax).
		sortOrder: integer('sort_order').notNull()
	},
	(table) => [
		// PLAN §9: transaction_charges(transaction_id).
		index('transaction_charges_transaction_id_idx').on(table.transactionId)
	]
);
