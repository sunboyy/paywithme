// Real-DB CONCURRENCY tests for the exponent freeze (issue #69 findings 1 + 3;
// PLAN §7.5.2 "Immutability"; ADR-0014 decision 5 + amendment).
//
// ── What this suite has to prove, and why nothing cheaper can ────────────────
// The freeze says: once a transaction references a custom currency, its `exponent`
// and `display_code` can no longer move — because changing the exponent silently
// reinterprets every minor-unit amount already stored against the row.
//
// The dangerous interleaving is the FIRST transaction in a currency racing an edit
// of that currency. It has three steps in two different transactions, and it only
// misbehaves when they interleave in one specific order:
//
//   T1 (create)  reads the exponent  ──────────┐               ┌── inserts the row
//   T2 (edit)                        ──────────┴─ FOR UPDATE, sees no reference,
//                                                 commits a NEW exponent ──┘
//
// Two sequential `await`s cannot express that: they would run T2 entirely before or
// entirely after T1, which are exactly the two orderings that were always safe. So
// these tests drive TWO REAL CONCURRENT CONNECTIONS to that one interleaving.
//
// ── How the interleaving is forced (deterministically, with no sleeps) ───────
// `createTransaction` is a black box — there is no seam between its read and its
// insert. So we put the seam in the DATABASE: a temporary `BEFORE INSERT ON
// transactions` trigger that takes an advisory lock, which THIS TEST holds. The
// trigger fires only for rows carrying our sentinel title, so nothing else in the
// suite (or the schema) is affected, and it is dropped in `afterAll` as well as
// `afterEach`.
//
//   1. the test session takes advisory lock K (session-level, dedicated `pg.Client`);
//   2. T1 starts; it reads the currency, reaches the insert, and BLOCKS in the
//      trigger on K — so we know for certain its read has happened and its insert
//      has not;
//   3. T2 (the edit) runs, on its own pooled connection;
//   4. the test releases K; T1 finishes.
//
// Waiting is by POLLING `pg_locks`, never by `sleep`: step 2 waits for an ungranted
// `advisory` lock, step 3 waits for T2 to either settle or block on a
// `transactionid` (which is what waiting for a row lock looks like).
//
// ── The assertion ────────────────────────────────────────────────────────────
// The create's body is arithmetically valid ONLY at exponent 2 (§7.6 makes the
// server recompute `amountTotalSettlement` from the resolved exponent and reject a
// mismatch), so a create that SUCCEEDS proves it resolved exponent 2. The invariant
// is therefore: if the transaction was stored, the currency must STILL be at
// exponent 2 and the edit must have been refused with `CurrencyImmutableError`.
// Both committing is the bug, and is what this fails on.

import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { createGroup } from '$lib/server/groups';
import {
	createCustomCurrency,
	updateCustomCurrency,
	CurrencyImmutableError
} from '$lib/server/currencies';
import {
	createTransaction,
	TransactionValidationError,
	type TransactionValidationError as TVE
} from '$lib/server/transactions';
import { currencies } from '$lib/server/db/currencies-schema';
import { transactions } from '$lib/server/db/transactions-schema';
import { members } from '$lib/server/db/groups-schema';
import { UNSUPPORTED_CURRENCY_MESSAGE } from '$lib/schemas/currency';
import { categoriesFor } from '$lib/categories';
import { cleanupSuiteRows, createTestUser, db, describeIntegration, IT_PREFIX } from './helpers';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

/** The title that arms the trigger. Only rows carrying it ever block. */
const RACE_TITLE = `${IT_PREFIX}race-freeze`;
/** The advisory-lock key the trigger and the test session share. */
const RACE_LOCK_KEY = 69_000_169;

const TRIGGER_SQL = `
	create or replace function it69_freeze_race_gate() returns trigger as $$
	begin
		if NEW.title = '${RACE_TITLE}' then
			-- Transaction-scoped, so it is released by the inserter's COMMIT/ROLLBACK
			-- and can never leak back into the pool with the connection.
			perform pg_advisory_xact_lock(${RACE_LOCK_KEY});
		end if;
		return NEW;
	end $$ language plpgsql;

	drop trigger if exists it69_freeze_race_gate on transactions;
	create trigger it69_freeze_race_gate
		before insert on transactions
		for each row execute function it69_freeze_race_gate();
`;

const DROP_TRIGGER_SQL = `
	drop trigger if exists it69_freeze_race_gate on transactions;
	drop function if exists it69_freeze_race_gate();
`;

describeIntegration('integration: the exponent freeze under real concurrency (issue #69)', () => {
	/** A DEDICATED session (never the pool) so the session-level advisory lock is ours. */
	let holder: Client;
	let user: { id: string; name: string };
	let group: { id: string };
	let memberId: string;
	let beerCode: string;

	beforeEach(async () => {
		holder = new Client({ connectionString: process.env.DATABASE_URL });
		await holder.connect();
		await holder.query(TRIGGER_SQL);

		user = await createTestUser('race');
		group = await createGroup({
			userId: user.id,
			userName: user.name,
			name: `${IT_PREFIX}race`,
			settlementCurrency: 'THB'
		});
		const [row] = await db
			.select({ id: members.id })
			.from(members)
			.where(eq(members.groupId, group.id));
		memberId = row.id;

		// A 2-decimal custom currency, referenced by NOTHING yet — the only state in
		// which its exponent may still move, and therefore the only state that races.
		const beer = await createCustomCurrency({
			userId: user.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 2 }
		});
		beerCode = beer.code;
	});

	afterEach(async () => {
		// Release anything still held before the trigger goes away, so a failed test
		// cannot wedge the next one.
		await holder.query(`select pg_advisory_unlock_all()`);
		// Give anything that was parked on the gate a moment to finish committing, so a
		// FAILED test cannot race its own cleanup into an FK violation and mask the real
		// failure with a second one.
		await new Promise((r) => setTimeout(r, 100));
		await holder.query(DROP_TRIGGER_SQL);
		await holder.end();

		await db.execute(sql`
			delete from transactions
			where group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await db.execute(sql`
			delete from currencies
			where created_by like ${IT_PREFIX + '%'}
			   or group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await cleanupSuiteRows();
	});

	afterAll(async () => {
		// Belt and braces: the trigger must never outlive the suite, even after a crash
		// mid-test. `afterEach` already dropped it in the normal path.
		const cleaner = new Client({ connectionString: process.env.DATABASE_URL });
		await cleaner.connect();
		await cleaner.query(DROP_TRIGGER_SQL);
		await cleaner.end();
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	/**
	 * 3.00 BEER at ฿1.50 each = ฿4.50. Valid ONLY at exponent 2: at exponent 0 the
	 * same 300 minor units are 300 beers, and §7.6 would require
	 * `amountTotalSettlement = 45000`. That asymmetry is what makes a SUCCESSFUL
	 * create proof of which exponent the service read.
	 */
	function beerInput(title = RACE_TITLE) {
		return {
			type: 'spending' as const,
			title,
			categoryId: SPENDING_CATEGORY,
			date: '2026-08-09',
			amountTotal: 300,
			currency: beerCode,
			// The scale these 300 minor units were parsed at. The service compares it to
			// the row it locks, so a create that succeeds proves the row was still at
			// exponent 2 — the same thing the settlement total proves here, stated
			// directly rather than inferred from the arithmetic.
			currencyExponent: 2,
			exchangeRate: '1.5',
			amountTotalSettlement: 450,
			splitMode: 'equal' as const,
			payers: [{ memberId, amountPaid: 300 }],
			beneficiaries: [{ memberId }],
			items: [],
			charges: []
		};
	}

	/** Poll until `predicate` holds; throws rather than hanging the suite forever. */
	async function waitUntil(predicate: () => Promise<boolean>, what: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (await predicate()) return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error(`timed out waiting for ${what}`);
	}

	/** Is some backend BLOCKED on a lock of this type? (`granted = false`.) */
	async function someoneWaitingOn(locktype: 'advisory' | 'transactionid'): Promise<boolean> {
		const res = await holder.query<{ n: string }>(
			`select count(*) as n from pg_locks where not granted and locktype = $1`,
			[locktype]
		);
		return Number(res.rows[0].n) > 0;
	}

	/** Settle a promise into a discriminated result rather than throwing. */
	function settle<T>(
		p: Promise<T>
	): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
		return p.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error })
		);
	}

	// ── Finding 1: the read must hold a lock through the insert ────────────────

	it('a create and a concurrent exponent edit can never BOTH commit', async () => {
		// 1. The test session owns the gate the trigger will block on.
		await holder.query(`select pg_advisory_lock($1)`, [RACE_LOCK_KEY]);

		// 2. T1: the real create, on its own pooled connection. It reads the currency,
		//    then blocks inside the trigger at the insert — so its read has DEFINITELY
		//    happened and its insert has DEFINITELY not.
		const create = settle(
			createTransaction({
				userId: user.id,
				groupId: group.id,
				input: beerInput(),
				settlementCurrency: 'THB'
			})
		);
		await waitUntil(() => someoneWaitingOn('advisory'), 'the create to reach its INSERT');

		// 3. T2: the edit, concurrently, in the window the bug lives in. With the fix it
		//    blocks on T1's `FOR SHARE`; without it, it runs straight through.
		let editSettled = false;
		const edit = settle(
			updateCustomCurrency({
				userId: user.id,
				groupId: group.id,
				code: beerCode,
				input: { exponent: 0 }
			})
		).then((r) => {
			editSettled = true;
			return r;
		});
		await waitUntil(
			async () => editSettled || (await someoneWaitingOn('transactionid')),
			'the edit to finish or block on the row lock'
		);

		// 4. Let the create through and collect both outcomes.
		await holder.query(`select pg_advisory_unlock($1)`, [RACE_LOCK_KEY]);
		const [createResult, editResult] = await Promise.all([create, edit]);

		const [stored] = await db
			.select({ id: transactions.id, amountTotal: transactions.amountTotal })
			.from(transactions)
			.where(eq(transactions.title, RACE_TITLE));
		const [row] = await db.select().from(currencies).where(eq(currencies.code, beerCode));

		if (createResult.ok) {
			// The create resolved exponent 2 (its body is valid at no other exponent) and
			// stored 300 minor units against this row. The exponent MUST still be 2, and
			// the edit MUST have been refused — otherwise those 300 minor units now read
			// as 300 beers instead of 3.00.
			expect(stored).toBeDefined();
			expect(row.exponent).toBe(2);
			expect(editResult.ok).toBe(false);
			expect(editResult.ok === false && editResult.error).toBeInstanceOf(CurrencyImmutableError);
		} else {
			// The other legal ordering: the edit won, so no transaction may exist.
			expect(stored).toBeUndefined();
			expect(editResult.ok).toBe(true);
			expect(row.exponent).toBe(0);
		}
	});

	it('the lock is genuinely SHARED — a concurrent reader does not block the create', async () => {
		// The STRENGTH is a decision, not an accident: `FOR SHARE` is the weakest lock
		// that conflicts with the editor's `FOR UPDATE`. Anything stronger would also
		// exclude other readers of the same row for no gain. Proven directly: a side
		// session holds `FOR SHARE` on the row for the whole create; a create that took
		// `FOR UPDATE` instead would block here and this test would hit its timeout.
		await holder.query('begin');
		await holder.query(`select * from currencies where code = $1 for share`, [beerCode]);

		const id = await createTransaction({
			userId: user.id,
			groupId: group.id,
			// A title the trigger does NOT arm on — the point here is the currency lock.
			input: beerInput(`${IT_PREFIX}shared-lock`),
			settlementCurrency: 'THB'
		});
		expect(typeof id).toBe('string');

		await holder.query('commit');
	});

	it('a SEEDED-currency create takes NO row lock on `currencies` (regression)', async () => {
		// The seeded fast path must survive the fix: a group that never defined a custom
		// currency must issue the queries it always did and take no new locks. We hold
		// the currency row EXCLUSIVELY on a side session; a create in THB must sail past
		// it, which it can only do by never touching the row.
		await holder.query('begin');
		await holder.query(`select * from currencies where code = $1 for update`, [beerCode]);

		const id = await createTransaction({
			userId: user.id,
			groupId: group.id,
			input: {
				...beerInput(`${IT_PREFIX}seeded-fast-path`),
				currency: 'THB',
				exchangeRate: '1',
				amountTotalSettlement: 300
			},
			settlementCurrency: 'THB'
		});
		expect(typeof id).toBe('string');

		await holder.query('commit');
	});

	// ── Finding 1, the CROSS-REQUEST half: the scale the caller parsed at ────────
	//
	// The lock above closes the window between this write's READ of the exponent and
	// its INSERT. It cannot close the bigger one: the caller parsed its amounts in an
	// EARLIER REQUEST, against a definition it read then, and a group-defined currency
	// stays re-scalable until something references it. No interleaving trickery is
	// needed for these — the edit commits first, completely, exactly as it would while
	// a member has the add-transaction form open.

	it('refuses amounts parsed at an exponent the currency no longer has', async () => {
		// The form was opened while BEER was 2-dp; 3.00 BEER was typed (300 minor units);
		// someone re-scaled BEER to 0-dp before Save. Those 300 units are now 300 beers.
		await updateCustomCurrency({
			userId: user.id,
			groupId: group.id,
			code: beerCode,
			input: { exponent: 0 }
		});

		const stale = await settle(
			createTransaction({
				userId: user.id,
				groupId: group.id,
				input: beerInput(`${IT_PREFIX}stale-exponent`),
				settlementCurrency: 'THB'
			})
		);

		expect(stale.ok).toBe(false);
		expect((stale as { error: unknown }).error).toBeInstanceOf(TransactionValidationError);
		const rows = await db.select().from(transactions).where(eq(transactions.groupId, group.id));
		expect(rows).toHaveLength(0);
	});

	it('refuses it even when the SETTLEMENT TOTAL cannot tell the two scales apart', async () => {
		// The case the §7.6 equality is blind to, and the reason the assertion exists.
		// `amountTotalSettlement` is a ROUNDING of the conversion, and for a small enough
		// amount × rate it is 0 at BOTH exponents:
		//   0.01 BEER (exp 2) @ 0.000001 → ฿0.000001 → 0
		//   1    BEER (exp 0) @ 0.000001 → ฿0.0001   → 0
		// So the server used to recompute the total, agree at 0, and commit — storing
		// `1` against a 0-dp row: ONE beer where the member entered a hundredth of one.
		const parsedAtExponent2 = {
			...beerInput(`${IT_PREFIX}rounds-to-zero`),
			amountTotal: 1,
			currencyExponent: 2,
			exchangeRate: '0.000001',
			amountTotalSettlement: 0,
			payers: [{ memberId, amountPaid: 1 }]
		};

		await updateCustomCurrency({
			userId: user.id,
			groupId: group.id,
			code: beerCode,
			input: { exponent: 0 }
		});

		const stale = await settle(
			createTransaction({
				userId: user.id,
				groupId: group.id,
				input: parsedAtExponent2,
				settlementCurrency: 'THB'
			})
		);

		expect(stale.ok).toBe(false);
		expect((stale as { error: unknown }).error).toBeInstanceOf(TransactionValidationError);
		const rows = await db.select().from(transactions).where(eq(transactions.groupId, group.id));
		expect(rows).toHaveLength(0);
	});

	it('accepts the write once the caller states the scale the row is ACTUALLY at', async () => {
		// The refusal is about the mismatch, not about the currency: re-entering the
		// amount against the current definition succeeds. 3 BEER (0-dp) @ ฿1.50 = ฿4.50.
		await updateCustomCurrency({
			userId: user.id,
			groupId: group.id,
			code: beerCode,
			input: { exponent: 0 }
		});

		const id = await createTransaction({
			userId: user.id,
			groupId: group.id,
			input: {
				...beerInput(`${IT_PREFIX}re-entered`),
				amountTotal: 3,
				currencyExponent: 0,
				amountTotalSettlement: 450,
				payers: [{ memberId, amountPaid: 3 }]
			},
			settlementCurrency: 'THB'
		});
		expect(typeof id).toBe('string');
	});

	// ── Finding 3: the display code the caller named, re-checked under the lock ──

	it('a display code renamed after translation is refused, exactly like an unknown one', async () => {
		// `/api/v1` translated `BEER` → the opaque key at the route boundary, OUTSIDE the
		// write's transaction. `display_code` is only frozen once a transaction
		// references the row — which is precisely what this write would be doing for the
		// first time — so a rename can commit in the gap. Here it already has.
		await updateCustomCurrency({
			userId: user.id,
			groupId: group.id,
			code: beerCode,
			input: { displayCode: 'PINT' }
		});

		const renamed = await settle(
			createTransaction({
				userId: user.id,
				groupId: group.id,
				input: beerInput(`${IT_PREFIX}renamed`),
				settlementCurrency: 'THB',
				expectedDisplayCode: 'BEER'
			})
		);
		const unknown = await settle(
			createTransaction({
				userId: user.id,
				groupId: group.id,
				input: { ...beerInput(`${IT_PREFIX}unknown`), currency: 'cur_does_not_exist' },
				settlementCurrency: 'THB'
			})
		);

		expect(renamed.ok).toBe(false);
		expect(unknown.ok).toBe(false);
		const renamedErr = (renamed as { error: unknown }).error;
		const unknownErr = (unknown as { error: unknown }).error;
		expect(renamedErr).toBeInstanceOf(TransactionValidationError);
		expect(unknownErr).toBeInstanceOf(TransactionValidationError);
		// The issues ARE the 422 body (`mapWriteError` flattens exactly these), so equal
		// issues mean a byte-identical response: a renamed code leaks no more than an
		// invented one (PLAN §7.5.2 "REST surface").
		expect(JSON.stringify((renamedErr as TVE).issues)).toBe(
			JSON.stringify((unknownErr as TVE).issues)
		);
		expect((renamedErr as TVE).issues[0].message).toBe(UNSUPPORTED_CURRENCY_MESSAGE);
		expect((renamedErr as TVE).issues[0].path).toEqual(['currency']);

		// Nothing was written under either name.
		const rows = await db.select().from(transactions).where(eq(transactions.groupId, group.id));
		expect(rows).toHaveLength(0);
	});

	it('a WEB write (no display code asserted) is unaffected by a rename', async () => {
		// The parameter must stay OPTIONAL: the web UI submits the opaque key straight
		// from the picker and has nothing to assert.
		await updateCustomCurrency({
			userId: user.id,
			groupId: group.id,
			code: beerCode,
			input: { displayCode: 'PINT' }
		});

		const id = await createTransaction({
			userId: user.id,
			groupId: group.id,
			input: beerInput(`${IT_PREFIX}web-write`),
			settlementCurrency: 'THB'
		});
		expect(typeof id).toBe('string');
	});
});
