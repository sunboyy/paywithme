// Real-DB integration tests — the `receiving_method` table (issue #83;
// PLAN §17.1, §17.2, §17.6; ADR-0016).
//
// This task is SCHEMA + REGISTRY only, and what it promises at the database level
// is exactly what no unit test can reach: an ON DELETE CASCADE that actually
// fires, an index that actually permits duplicate positions, and a `details`
// column the database accepts without knowing its shape. The unit spec
// (`src/lib/server/db/receiving-schema.test.ts`) asserts the Drizzle table shape
// and the migration's SQL text; only this suite proves the running database agrees.
//
// Cleanup: `receiving_method.user_id` is `onDelete: 'cascade'`, so every row this
// suite writes goes with `cleanupSuiteRows()`'s user delete — which is the same
// mechanism the first test below is checking, so the tests also delete explicitly
// where they must not depend on it.

import { afterEach, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { receivingMethod } from '$lib/server/db/receiving-schema';
import { parseRailDetails } from '$lib/server/payout-rails';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

/** Postgres SQLSTATEs this schema is expected to raise. */
const NOT_NULL_VIOLATION = '23502';
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Drizzle wraps driver failures, so the SQLSTATE lives somewhere on the `cause`
 * chain rather than on the thrown value (see `src/lib/server/db/pg-errors.ts`).
 * Local to this suite, like the other schema suites: this task adds no production
 * error helper.
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

/** A valid `th_bank_account` payload, parsed through the registry as a write would. */
function bankDetails(accountNumber = '1234567890'): unknown {
	const parsed = parseRailDetails('th_bank_account', {
		bank: 'kbank',
		accountNumber,
		accountHolderName: 'Somchai Jaidee'
	});
	if (!parsed.success) throw new Error('fixture must be valid');
	return parsed.details;
}

describeIntegration('integration: receiving_method (PLAN §17.6; ADR-0016)', () => {
	afterEach(async () => {
		await cleanupSuiteRows();
	});

	it('deletes a user’s methods with the user (ON DELETE CASCADE)', async () => {
		const owner = await createTestUser('owner');
		const other = await createTestUser('bystander');

		await db.insert(receivingMethod).values([
			{ userId: owner.id, rail: 'th_bank_account', details: bankDetails(), position: 0 },
			{ userId: owner.id, rail: 'other', details: { label: 'Wise', text: 'IBAN…' }, position: 1 },
			{ userId: other.id, rail: 'th_bank_account', details: bankDetails('9876543210'), position: 0 }
		]);

		await db.execute(sql`delete from "user" where id = ${owner.id}`);

		// The owner's methods are GONE — not orphaned, not null-linked. Deliberately
		// unlike `members.user_id`'s `set null`: a member slot carries ledger history
		// worth preserving, a receiving method carries none (§17.6).
		const survivors = await db.select().from(receivingMethod);
		expect(survivors.filter((row) => row.userId === owner.id)).toHaveLength(0);
		// …and only the owner's: the cascade is scoped to the deleted user.
		expect(survivors.filter((row) => row.userId === other.id)).toHaveLength(1);
	});

	it('requires an owner that exists', async () => {
		await expectPgError(
			() =>
				db.insert(receivingMethod).values({
					userId: 'it39-no-such-user',
					rail: 'other',
					details: { label: 'Wise', text: 'IBAN…' },
					position: 0
				}),
			FOREIGN_KEY_VIOLATION
		);

		await expectPgError(
			() =>
				db.execute(sql`
					insert into receiving_method (id, user_id, rail, details, position)
					values ('it39-orphan', null, 'other', '{}'::jsonb, 0)
				`),
			NOT_NULL_VIOLATION
		);
	});

	it('permits duplicate positions, and orders ties stably by id', async () => {
		const owner = await createTestUser('reorder');

		// A reorder that momentarily lands two rows on the same position must be a
		// plain UPDATE, not a temp-value dance — which is why the (user_id, position)
		// index is NOT unique.
		await db.insert(receivingMethod).values([
			{
				id: 'it39-rm-b',
				userId: owner.id,
				rail: 'other',
				details: { label: 'B', text: 'b' },
				position: 0
			},
			{
				id: 'it39-rm-a',
				userId: owner.id,
				rail: 'other',
				details: { label: 'A', text: 'a' },
				position: 0
			},
			{
				id: 'it39-rm-c',
				userId: owner.id,
				rail: 'other',
				details: { label: 'C', text: 'c' },
				position: 1
			}
		]);

		const ordered = await db
			.select()
			.from(receivingMethod)
			.where(eq(receivingMethod.userId, owner.id))
			.orderBy(asc(receivingMethod.position), asc(receivingMethod.id));

		// Ties break by id, so the order is the SAME on every read — the ambiguity a
		// duplicate position creates is resolved by the query, not by the planner.
		expect(ordered.map((row) => row.id)).toEqual(['it39-rm-a', 'it39-rm-b', 'it39-rm-c']);

		// Repeat the read: identical, not merely "some order".
		const again = await db
			.select()
			.from(receivingMethod)
			.where(eq(receivingMethod.userId, owner.id))
			.orderBy(asc(receivingMethod.position), asc(receivingMethod.id));
		expect(again.map((row) => row.id)).toEqual(ordered.map((row) => row.id));
	});

	it('stores `details` as jsonb and round-trips it as an object', async () => {
		const owner = await createTestUser('jsonb');
		const details = bankDetails();

		await db
			.insert(receivingMethod)
			.values({ userId: owner.id, rail: 'th_bank_account', details, position: 0 });

		const [row] = await db
			.select()
			.from(receivingMethod)
			.where(eq(receivingMethod.userId, owner.id));

		// An object comes back an object (jsonb), not a JSON string.
		expect(row.details).toEqual(details);
		expect(typeof row.details).toBe('object');

		const [{ data_type: dataType }] = (
			await db.execute(sql`
				select data_type from information_schema.columns
				where table_schema = 'public' and table_name = 'receiving_method'
				  and column_name = 'details'
			`)
		).rows as { data_type: string }[];
		expect(dataType).toBe('jsonb');
	});

	it('lets the DATABASE accept any rail string — the registry is the only gate', async () => {
		const owner = await createTestUser('rail-agnostic');

		// Storage is rail-agnostic on purpose (ADR-0016): no enum, no FK, no check
		// constraint, so adding a country is a code change with NO migration. The
		// price is that rejecting an unknown rail is entirely the app's job — which
		// `parseRailDetails` does, and this row is what it prevents.
		expect(parseRailDetails('sepa', { iban: 'DE89…' })).toEqual({
			success: false,
			reason: 'unknown_rail'
		});
		await db
			.insert(receivingMethod)
			.values({ userId: owner.id, rail: 'sepa', details: { iban: 'DE89…' }, position: 0 });

		const [row] = await db
			.select()
			.from(receivingMethod)
			.where(eq(receivingMethod.userId, owner.id));
		expect(row.rail).toBe('sepa');
	});
});
