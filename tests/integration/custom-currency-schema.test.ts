// Real-DB integration tests — the GROUP-SCOPED `currencies` table (issue #59;
// PLAN §7.5.2, §9; ADR-0014).
//
// This task is SCHEMA ONLY, and everything it promises is a database guarantee
// that no unit test can reach: a migration BACKFILL over the already-seeded rows,
// a UNIQUE INDEX whose semantics depend on Postgres treating NULLs as distinct, an
// ON DELETE CASCADE, and — the load-bearing claim of ADR-0014 — that
// `transactions.currency`'s foreign key to `currencies.code` is still intact and
// still rejects an unknown code. The unit spec
// (`src/lib/server/db/currencies-schema.test.ts`) asserts the Drizzle table shape
// and the migration's SQL text; only this suite proves the running database agrees.
//
// Cleanup: `currencies.group_id` is `onDelete: 'cascade'`, so custom rows created
// here go with `cleanupSuiteRows()`'s group deletion. The `afterEach` below deletes
// them explicitly FIRST anyway, because `created_by` is `onDelete: 'set null'` —
// a row that somehow outlived its group would survive the user delete and pollute
// the seeded table.

import { afterEach, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { currencies } from '$lib/server/db/currencies-schema';
import { transactions } from '$lib/server/db/transactions-schema';
import { CURRENCIES } from '$lib/money/currencies';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration, IT_PREFIX } from './helpers';

/** Postgres SQLSTATEs the schema is expected to raise. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

/**
 * Drizzle wraps driver failures, so the SQLSTATE lives somewhere on the `cause`
 * chain rather than on the thrown value (see `src/lib/server/db/pg-errors.ts`).
 * Local to this suite: the production helper only exposes the unique-violation
 * probe, and this task adds no production code beyond the schema itself.
 */
async function expectPgError(run: () => Promise<unknown>, code: string): Promise<void> {
	let thrown: unknown;
	try {
		await run();
	} catch (e) {
		thrown = e;
	}
	expect(thrown, `expected SQLSTATE ${code}, but nothing was thrown`).toBeDefined();
	let found = false;
	for (let cur: unknown = thrown, depth = 0; cur != null && depth < 5; depth++) {
		if (typeof cur === 'object' && 'code' in cur && (cur as { code: unknown }).code === code) {
			found = true;
			break;
		}
		cur = (cur as { cause?: unknown }).cause;
	}
	expect(found, `expected SQLSTATE ${code}, got: ${String(thrown)}`).toBe(true);
}

describeIntegration('integration: group-scoped currencies (PLAN §7.5.2; ADR-0014)', () => {
	/** Create a group owned by a fresh suite-prefixed user. */
	async function freshGroup(label = 'g') {
		const user = await createTestUser(label);
		const group = await createGroup({
			userId: user.id,
			userName: user.name,
			name: `${IT_PREFIX}${label}`,
			// A SEEDED code — a custom currency may never be the settlement currency
			// (ADR-0014 decision 1), which is exactly why this stays 'THB'.
			settlementCurrency: 'THB'
		});
		return { user, group };
	}

	/**
	 * Insert a custom currency row the way the (later) service will: `code` is
	 * OMITTED so the schema's `$defaultFn` mints the opaque id, and only
	 * `display_code` is user-facing.
	 */
	function insertCustom(
		groupId: string,
		createdBy: string,
		displayCode: string,
		overrides: { name?: string; symbol?: string; exponent?: number } = {}
	) {
		return db
			.insert(currencies)
			.values({
				groupId,
				createdBy,
				displayCode,
				name: overrides.name ?? `${displayCode} unit`,
				symbol: overrides.symbol ?? '🍺',
				exponent: overrides.exponent ?? 0,
				createdAt: new Date()
			})
			.returning();
	}

	afterEach(async () => {
		// `transactions.currency → currencies.code` is RESTRICT, so this suite's
		// ledger rows must go before its custom currencies.
		await db.execute(sql`
			delete from transactions
			where group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		// Custom rows next (see the module header), then the shared cleanup.
		await db.execute(sql`
			delete from currencies
			where created_by like ${IT_PREFIX + '%'}
			   or group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await cleanupSuiteRows();
	});

	// ── The migration's backfill over the 29 already-seeded rows ───────────────

	it('backfilled display_code = code on every seeded row, leaving the new columns NULL', async () => {
		const seeded = await db.select().from(currencies).where(isNull(currencies.groupId));

		// Exactly the 29 canonical rows (`src/lib/money/currencies.ts`), no extras.
		expect(seeded).toHaveLength(CURRENCIES.length);
		expect(seeded.map((r) => r.code).sort()).toEqual(CURRENCIES.map((c) => c.code).sort());

		for (const row of seeded) {
			// The whole point of the backfill: a seeded row's user-visible code IS its PK.
			expect(row.displayCode, `display_code for ${row.code}`).toBe(row.code);
			// NULL `group_id` is what MARKS the row seeded; the other two follow.
			expect(row.groupId).toBeNull();
			expect(row.createdBy, `created_by for ${row.code}`).toBeNull();
			expect(row.createdAt, `created_at for ${row.code}`).toBeNull();
		}
	});

	it('left the seeded name/exponent/symbol untouched', async () => {
		const seeded = await db.select().from(currencies).where(isNull(currencies.groupId));
		const byCode = new Map(seeded.map((r) => [r.code, r]));
		for (const c of CURRENCIES) {
			const row = byCode.get(c.code);
			expect(row, `seeded row for ${c.code}`).toBeDefined();
			expect(row?.name).toBe(c.name);
			expect(row?.exponent).toBe(c.exponent);
			expect(row?.symbol).toBe(c.symbol);
		}
	});

	it('requires display_code — it is NOT NULL for custom rows too', async () => {
		const { user, group } = await freshGroup();
		await expectPgError(
			() =>
				db.execute(sql`
					insert into currencies ("code", "name", "exponent", "symbol", "group_id", "created_by")
					values (${'cur_' + crypto.randomUUID()}, 'No display code', 0, 'X',
					        ${group.id}, ${user.id})
				`),
			NOT_NULL_VIOLATION
		);
	});

	// ── UNIQUE (group_id, display_code) ───────────────────────────────────────

	it('rejects a duplicate display_code within one group', async () => {
		const { user, group } = await freshGroup();
		await insertCustom(group.id, user.id, 'BEER');
		await expectPgError(
			// Different name/symbol/exponent, different (opaque) code — still a duplicate,
			// because per-group uniqueness is on the USER-VISIBLE code.
			() => insertCustom(group.id, user.id, 'BEER', { name: 'Other beer', exponent: 2 }),
			UNIQUE_VIOLATION
		);
		const rows = await db
			.select()
			.from(currencies)
			.where(and(eq(currencies.groupId, group.id), eq(currencies.displayCode, 'BEER')));
		expect(rows).toHaveLength(1);
	});

	it('permits the same display_code in two different groups', async () => {
		const a = await freshGroup('ga');
		const b = await freshGroup('gb');

		const [rowA] = await insertCustom(a.group.id, a.user.id, 'BEER');
		const [rowB] = await insertCustom(b.group.id, b.user.id, 'BEER');

		expect(rowA.displayCode).toBe('BEER');
		expect(rowB.displayCode).toBe('BEER');
		// Distinct opaque PKs — "a user in three groups defining BEER three times is
		// an acceptable cost" (ADR-0014).
		expect(rowA.code).not.toBe(rowB.code);
		expect(rowA.code.startsWith('cur_')).toBe(true);
		expect(rowB.code.startsWith('cur_')).toBe(true);
	});

	it('permits a custom row whose display_code shadows a seeded code', async () => {
		const { user, group } = await freshGroup();
		// The hardest case for the index: a group reuses a SEEDED code as its own
		// display code. Permitted — the unique index is per-group and seeded rows have
		// `group_id IS NULL`, which Postgres treats as distinct.
		const [custom] = await insertCustom(group.id, user.id, 'USD', {
			name: 'Arcade dollar',
			exponent: 2,
			symbol: '$'
		});
		expect(custom.displayCode).toBe('USD');
		expect(custom.code).not.toBe('USD');

		// The seeded USD row is untouched and still keyed by the ISO code itself.
		const [seededUsd] = await db.select().from(currencies).where(eq(currencies.code, 'USD'));
		expect(seededUsd.displayCode).toBe('USD');
		expect(seededUsd.groupId).toBeNull();

		// Both rows exist under that display code, distinguished only by `group_id`.
		const both = await db.select().from(currencies).where(eq(currencies.displayCode, 'USD'));
		expect(both).toHaveLength(2);
	});

	it('does not let the opaque code collide with the seeded primary keys', async () => {
		const { user, group } = await freshGroup();
		const [custom] = await insertCustom(group.id, user.id, 'BEER');
		expect(CURRENCIES.map((c) => c.code)).not.toContain(custom.code);
		expect(custom.code).not.toMatch(/^[A-Z]{3}$/);
	});

	// ── Lifetime: group cascade, author set-null ──────────────────────────────

	it('cascades a group delete to its custom currencies', async () => {
		const { user, group } = await freshGroup();
		const [custom] = await insertCustom(group.id, user.id, 'BEER');

		// A HARD group delete (v1 soft-deletes; this is the non-v1 cleanup path).
		await db.execute(sql`delete from groups where id = ${group.id}`);

		const after = await db.select().from(currencies).where(eq(currencies.code, custom.code));
		expect(after).toHaveLength(0);
		// And the seeded rows are obviously untouched by a group delete.
		const seeded = await db.select().from(currencies).where(isNull(currencies.groupId));
		expect(seeded).toHaveLength(CURRENCIES.length);
	});

	it('nulls created_by (never deletes the row) when the author is deleted', async () => {
		const { user, group } = await freshGroup();
		const [custom] = await insertCustom(group.id, user.id, 'BEER');

		// `groups.created_by` is `restrict`, so delete the currency's author only —
		// use a second member-less user as the currency author for this case.
		const author = await createTestUser('author');
		await db
			.update(currencies)
			.set({ createdBy: author.id })
			.where(eq(currencies.code, custom.code));
		await db.execute(sql`delete from "user" where id = ${author.id}`);

		const [after] = await db.select().from(currencies).where(eq(currencies.code, custom.code));
		expect(after, 'the row must survive its author').toBeDefined();
		expect(after.createdBy).toBeNull();
		expect(after.groupId).toBe(group.id);
	});

	// ── The FK this whole design exists to preserve (ADR-0014) ────────────────

	it('still rejects an unknown code on transactions.currency', async () => {
		const { user, group } = await freshGroup();
		await expectPgError(
			() =>
				db.insert(transactions).values({
					groupId: group.id,
					type: 'spending',
					title: 'Bad currency',
					categoryId: SPENDING_CATEGORY,
					amountTotal: 1000,
					currency: 'ZZZ',
					exchangeRate: '1',
					amountTotalSettlement: 1000,
					splitMode: 'equal',
					createdBy: user.id
				}),
			FOREIGN_KEY_VIOLATION
		);
	});

	it('accepts a custom currency row as an entry currency via the unchanged FK', async () => {
		const { user, group } = await freshGroup();
		const [custom] = await insertCustom(group.id, user.id, 'BEER');

		// No FK surgery: the ledger points at `currencies.code` exactly as before and
		// cannot tell the two kinds of row apart (ADR-0014 decision 3).
		const [txn] = await db
			.insert(transactions)
			.values({
				groupId: group.id,
				type: 'spending',
				title: 'Three beers',
				categoryId: SPENDING_CATEGORY,
				amountTotal: 3,
				currency: custom.code,
				// Always foreign, so a rate is always required: 1 BEER = 250 THB.
				exchangeRate: '250',
				amountTotalSettlement: 75_000,
				splitMode: 'equal',
				createdBy: user.id
			})
			.returning();
		expect(txn.currency).toBe(custom.code);

		// A display path joins and reads `display_code`, never the opaque `code`.
		const [joined] = await db
			.select({ displayCode: currencies.displayCode, exponent: currencies.exponent })
			.from(transactions)
			.innerJoin(currencies, eq(transactions.currency, currencies.code))
			.where(eq(transactions.id, txn.id));
		expect(joined.displayCode).toBe('BEER');
		expect(joined.exponent).toBe(0);
	});
});
