import { pgTable, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

// Drizzle table for RECEIVING METHODS (issue #83; PLAN §17.1, §17.2, §17.6;
// ADR-0016).
//
// SCHEMA-ONLY: the table + its index. The rail registry that gives `rail` and
// `details` their meaning is `$lib/server/payout-rails`; the CRUD service, the
// editor and the settle-screen surface are later tasks.
//
// Conventions mirror `groups-schema.ts`: `text('id')` PK generated in-app with
// `crypto.randomUUID()`, camelCase property keys → snake_case columns, and
// `timestamp(...).defaultNow().notNull()` for `created_at`.
//
// ── Rail-agnostic storage (PLAN §17.2) ───────────────────────────────────────
// `rail` is TEXT — no enum, no FK, no check constraint — and `details` is jsonb.
// THE DATABASE DOES NOT KNOW THE SHAPE OF `details` AND MUST NOT BE TAUGHT IT: a
// rail owns its own field schema, validation, display formatting and (later) QR
// encoder, because all four vary by country and none generalise (ADR-0016). Every
// write validates `details` against the rail's Zod schema first, and an unknown
// rail key is rejected there — so adding a country is one registry entry, with no
// migration and no touching existing rows.
//
// ── NO audit_log row (ADR-0016, a deliberate exception to CLAUDE.md/§12.1) ────
// `audit_log` rows are GROUP-SCOPED and readable by every member of that group; a
// receiving method belongs to a USER, so there is no correct `group_id` to write,
// and fanning one out would broadcast "X changed their bank account" into every
// group they are in. This feature never touches the ledger. Do not "fix" this.

export const receivingMethod = pgTable(
	'receiving_method',
	{
		// In-app generated UUID (text PK), consistent with every other table here.
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		// The owner (PLAN §17.1: a method belongs to a user, never to a member and
		// never to a group).
		//
		// `cascade`, DELIBERATELY UNLIKE `members.user_id`'s `set null`: a member slot
		// carries ledger history worth preserving after its user is gone, a receiving
		// method carries none — nothing references it (PLAN §17.5: no transaction
		// records which method was used), so when the user goes, it goes.
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		// The registry key, e.g. 'th_bank_account'. Plain text: see the header.
		rail: text('rail').notNull(),
		// The rail's fields, validated by that rail's Zod schema on every write.
		details: jsonb('details').notNull(),
		// Ordering within the user's receiving profile; the FIRST is what the settle
		// screen shows and the rest sit behind "other ways to pay" (PLAN §17.1). The
		// order IS the preference — there is no separate `is_default` flag, which
		// would be a second source of truth able to contradict it.
		position: integer('position').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull()
	},
	(table) => [
		// The one access path: a user's profile, in order (PLAN §17.6).
		//
		// PLAIN index, NOT unique. A unique `(user_id, position)` would turn every
		// reorder into a temp-value dance (shift each row out of the way, then back)
		// for no benefit: duplicate positions are merely an ambiguous order, not
		// corrupt data. Reads therefore order by `(position, id)` — the `id`
		// tie-break is what keeps a tie STABLE across reads instead of leaving it to
		// the planner.
		index('receiving_method_user_id_position_idx').on(table.userId, table.position)
	]
);
