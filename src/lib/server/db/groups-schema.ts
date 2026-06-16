import { isNotNull } from 'drizzle-orm';
import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

// Domain schema for groups, members, and invites (task 3.1; PLAN §6, §9).
//
// SCHEMA-ONLY: tables + indexes/constraints. No CRUD, no currency seeding
// (that's 3.2), no routes/UI. Conventions mirror the hand-authored
// `rate-limit-schema.ts` and the generated `auth-schema.ts`:
//   - `text('id')` PKs, generated in-app with `crypto.randomUUID()` so the app
//     owns identity (consistent with the text `user.id` FKs these tables
//     reference — no DB sequence / serial).
//   - camelCase property keys → snake_case column names.
//   - `timestamp(...).defaultNow().notNull()` for `created_at`.
//   - nullable timestamps for soft-delete / soft-deactivate / revoke.
//
// onDelete semantics (chosen to preserve ledger history per PLAN §6.3):
//   - `created_by` (groups, invites) → user.id is NOT NULL and uses the default
//     `restrict` (no `onDelete` clause): a user who created history can't be
//     deleted out from under it. Authorship is durable.
//   - `members.user_id` → user.id is NULLABLE and uses `onDelete: 'set null'`:
//     deleting a user UNLINKS their member slot (the slot stays in the ledger)
//     rather than destroying transaction history.
//   - `members.group_id` / `invites.group_id` → groups.id use
//     `onDelete: 'cascade'`: groups are SOFT-deleted in v1 (`deleted_at`), so a
//     real row delete only happens in non-v1 cleanup, where dropping the group's
//     members/invites with it is correct.
//   - invites are MEMBER-AGNOSTIC (PLAN §6.2): a link grants entry to the group,
//     not to a pre-chosen slot, so there is no `invites.member_id` FK at all — the
//     invitee picks link-existing vs create-new at accept time.

export const groups = pgTable('groups', {
	// In-app generated UUID (text PK), consistent with the text `user.id` FKs.
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull(),
	// Required ISO-4217-style currency code (e.g. 'USD'). Locking after the first
	// transaction is a later concern (§6.4) — here it's just the column.
	settlementCurrency: text('settlement_currency').notNull(),
	// Author of the group → better-auth user.id. NOT NULL + default restrict.
	createdBy: text('created_by')
		.notNull()
		.references(() => user.id),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	// Soft-delete (§6.4): nullable; non-null hides the group everywhere.
	deletedAt: timestamp('deleted_at')
});

export const members = pgTable(
	'members',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		groupId: text('group_id')
			.notNull()
			.references(() => groups.id, { onDelete: 'cascade' }),
		displayName: text('display_name').notNull(),
		// Nullable link to a real user (§6.2). Set on invite accept; unlinked
		// members are still valid ledger participants. `set null` on user delete.
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		// Soft-deactivate (§6.3): nullable; deactivated members stay in the ledger
		// but are hidden from new-transaction pickers.
		deactivatedAt: timestamp('deactivated_at')
	},
	(table) => [
		index('members_group_id_idx').on(table.groupId),
		index('members_user_id_idx').on(table.userId),
		// "One member per user per group" (PLAN §9). PARTIAL unique index: only
		// rows with a non-null user_id are constrained, so a group may hold many
		// unlinked (user_id IS NULL) member slots. The WHERE predicate is what
		// makes this a partial index — a plain composite unique would wrongly
		// collapse multiple unlinked members into one allowed row.
		uniqueIndex('members_group_id_user_id_unique')
			.on(table.groupId, table.userId)
			.where(isNotNull(table.userId))
	]
);

export const invites = pgTable(
	'invites',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		groupId: text('group_id')
			.notNull()
			.references(() => groups.id, { onDelete: 'cascade' }),
		// Unique opaque lookup token (the URL secret). Unique also provides the
		// find-by-token index the accept flow uses.
		token: text('token').notNull().unique(),
		// MEMBER-AGNOSTIC (§6.2): the link carries NO target member — the invitee
		// chooses at accept time to claim an unlinked slot or create a new member.
		// Required 7-day expiry (§6.2); enforcement of the window is a later concern.
		expiresAt: timestamp('expires_at').notNull(),
		// Soft-revoke (§6.2): nullable; non-null means the link is no longer valid.
		revokedAt: timestamp('revoked_at'),
		createdBy: text('created_by')
			.notNull()
			.references(() => user.id),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [
		// Invite management lists by group; token lookups use the UNIQUE above.
		index('invites_group_id_idx').on(table.groupId),
		index('invites_token_idx').on(table.token)
	]
);
