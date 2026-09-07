// Real-DB integration tests — the CAPTURE SERVICE (issue #49; PLAN §7.7, §9, §12,
// §12.1; ADR-0012).
//
// The sibling unit suite (`src/lib/server/captures.test.ts`) pins the order of
// operations against a stub. This one drives the SERVICE against a running
// Postgres, because every claim below is a claim about a real transaction and a
// real WHERE clause:
//
//   1. AUDIT ATOMICITY (§12.1). A create that fails INSIDE the transaction leaves
//      NEITHER a `captures` row NOR an `audit_log` row. A stub cannot show this —
//      only a real rollback can.
//   2. OPEN vs RESOLVED vs DISCARDED. The tray's predicate is
//      `resolved_at IS NULL AND discarded_at IS NULL`, and the only way to prove
//      a discarded row doesn't linger is to discard one and look.
//   3. MEMBERSHIP (§12) against real member rows, and GROUP VISIBILITY — a second
//      member sees the first member's open Captures.
//   4. THE AMOUNT STAYS UNINTERPRETED. Stored in a currency that is NOT the
//      group's settlement currency, with no rate anywhere, and read back
//      byte-identical.
//
// Cleanup: `captures.group_id` and `transactions.group_id` both cascade from
// `groups`, so `cleanupSuiteRows` (which deletes this suite's groups) takes them
// with it; the transactions are deleted first anyway, mirroring the sibling suites.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createGroup, GroupAccessError } from '$lib/server/groups';
import {
	createCapture,
	listOpenCaptures,
	resolveCapture,
	discardCapture,
	CaptureNotFoundError,
	CaptureNotOpenError,
	CaptureValidationError
} from '$lib/server/captures';
import { TransactionNotFoundError } from '$lib/server/transactions';
import { captures } from '$lib/server/db/captures-schema';
import { transactions } from '$lib/server/db/transactions-schema';
import { auditLog } from '$lib/server/db/audit-schema';
import { members } from '$lib/server/db/groups-schema';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration, IT_PREFIX } from './helpers';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

describeIntegration('integration: capture service (issue #49; PLAN §7.7)', () => {
	let userA: { id: string; name: string };
	let userB: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
		userB = await createTestUser('b');
	});

	afterEach(async () => {
		await db.execute(sql`
			delete from transactions
			where group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await cleanupSuiteRows();
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	/** A group owned by `userA`, settling in THB. */
	async function freshGroup(label = 'g') {
		return createGroup({
			userId: userA.id,
			userName: userA.name,
			name: `${IT_PREFIX}${label}`,
			settlementCurrency: 'THB'
		});
	}

	/** Link `userB` into the group as a second ACTIVE member. */
	async function addSecondMember(groupId: string) {
		await db.insert(members).values({
			groupId,
			displayName: `${IT_PREFIX}b`,
			normalizedDisplayName: `${IT_PREFIX}b`.toLowerCase(),
			userId: userB.id
		});
	}

	/** This group's capture rows, as stored. */
	async function captureRows(groupId: string) {
		return db.select().from(captures).where(eq(captures.groupId, groupId));
	}

	/** This group's audit rows for the `capture` entity kind. */
	async function captureAuditRows(groupId: string) {
		return db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.groupId, groupId), eq(auditLog.entityType, 'capture')));
	}

	/** A real ledger transaction in the group, inserted straight into the table. */
	async function recordTransaction(groupId: string) {
		const [txn] = await db
			.insert(transactions)
			.values({
				groupId,
				type: 'spending',
				title: 'Dinner',
				categoryId: SPENDING_CATEGORY,
				amountTotal: 120_000,
				currency: 'THB',
				exchangeRate: '1',
				amountTotalSettlement: 120_000,
				splitMode: 'equal',
				createdBy: userA.id
			})
			.returning();
		return txn;
	}

	// ── 1. Create + audit atomicity (§12.1) ───────────────────────────────────

	it('stores a Capture and exactly one audit row, in one transaction', async () => {
		const group = await freshGroup();

		const row = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: {
				note: '  dinner at the night market  ',
				amountMinor: 120_000,
				currency: 'THB',
				capturedFor: '2026-09-05'
			}
		});

		expect(row.groupId).toBe(group.id);
		expect(row.createdBy).toBe(userA.id);
		expect(row.note).toBe('dinner at the night market');
		expect(row.amountMinor).toBe(120_000);
		expect(row.currency).toBe('THB');
		// A DATE column, read back as the calendar day it was given.
		expect(row.capturedFor).toBe('2026-09-05');
		// Open: neither ending has happened.
		expect(row.resolvedAt).toBeNull();
		expect(row.resolvedTransactionId).toBeNull();
		expect(row.discardedAt).toBeNull();
		// `created_at` is the plain server insert time here (NOT §7.1's reversal).
		expect(row.createdAt).toBeInstanceOf(Date);

		const entries = await captureAuditRows(group.id);
		expect(entries).toHaveLength(1);
		expect(entries[0].action).toBe('create');
		expect(entries[0].entityId).toBe(row.id);
		expect(entries[0].actorUserId).toBe(userA.id);
		// The durable summary denormalizes the note and never says "capture".
		expect(entries[0].summary).toBe("Noted 'dinner at the night market' as not recorded yet");
		expect(entries[0].summary.toLowerCase()).not.toContain('capture');
	});

	it('stores a note-only Capture with both money columns NULL', async () => {
		const group = await freshGroup();

		const row = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'that taxi' }
		});

		expect(row.amountMinor).toBeNull();
		expect(row.currency).toBeNull();
	});

	it('a FAILED create leaves NEITHER a capture row NOR an audit row (§12.1)', async () => {
		const group = await freshGroup();

		// A NUL byte passes Zod (it is a perfectly ordinary JS string character) and is
		// then REFUSED by Postgres, which cannot store it in a `text` column. So the
		// failure lands INSIDE the transaction, after the insert has been attempted —
		// exactly the window §12.1's same-transaction rule exists to cover.
		await expect(
			createCapture({ userId: userA.id, groupId: group.id, input: { note: 'dinner\u0000' } })
		).rejects.toThrow();

		expect(await captureRows(group.id)).toHaveLength(0);
		expect(await captureAuditRows(group.id)).toHaveLength(0);
	});

	it('a create rejected for NO ACCESS writes neither row (§12)', async () => {
		const group = await freshGroup();

		await expect(
			createCapture({ userId: userB.id, groupId: group.id, input: { note: 'dinner' } })
		).rejects.toBeInstanceOf(GroupAccessError);

		expect(await captureRows(group.id)).toHaveLength(0);
		expect(await captureAuditRows(group.id)).toHaveLength(0);
	});

	it('a create rejected for an unusable currency writes neither row', async () => {
		const group = await freshGroup();

		await expect(
			createCapture({
				userId: userA.id,
				groupId: group.id,
				input: { note: 'a round', amountMinor: 3, currency: 'cur_not_this_group' }
			})
		).rejects.toBeInstanceOf(CaptureValidationError);

		expect(await captureRows(group.id)).toHaveLength(0);
		expect(await captureAuditRows(group.id)).toHaveLength(0);
	});

	// ── 2. The amount stays uninterpreted (§7.7 "Edge cases") ─────────────────

	it('keeps a FOREIGN-currency amount exactly as given, with no conversion', async () => {
		const group = await freshGroup(); // settles in THB

		const row = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'airport coffee', amountMinor: 450, currency: 'USD' }
		});

		const [stored] = await captureRows(group.id);
		// 450 minor units of USD in a THB group: no rate was looked up, nothing was
		// converted, and there is no settlement column for a conversion to land in.
		expect(stored.amountMinor).toBe(450);
		expect(stored.currency).toBe('USD');
		expect(stored).not.toHaveProperty('exchangeRate');
		expect(stored).not.toHaveProperty('amountMinorSettlement');
		expect(Object.keys(stored).sort()).toEqual([
			'amountMinor',
			'capturedFor',
			'createdAt',
			'createdBy',
			'currency',
			'discardedAt',
			'groupId',
			'id',
			'note',
			'resolvedAt',
			'resolvedTransactionId'
		]);
		expect(row.amountMinor).toBe(stored.amountMinor);
	});

	// ── 3. Open vs resolved vs discarded ──────────────────────────────────────

	it('lists ONLY open Captures — resolved and discarded rows drop out', async () => {
		const group = await freshGroup();
		const other = await freshGroup('other');
		const txn = await recordTransaction(group.id);

		const open = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'still open', capturedFor: '2026-09-05' }
		});
		const toResolve = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'will be recorded', capturedFor: '2026-09-04' }
		});
		const toDiscard = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'never mind', capturedFor: '2026-09-03' }
		});
		// A Capture in ANOTHER group must never appear in this group's tray.
		await createCapture({ userId: userA.id, groupId: other.id, input: { note: 'other group' } });

		expect((await listOpenCaptures(userA.id, group.id)).map((c) => c.id)).toEqual([
			open.id,
			toResolve.id,
			toDiscard.id
		]);

		await resolveCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: toResolve.id,
			transactionId: txn.id
		});
		await discardCapture({ userId: userA.id, groupId: group.id, captureId: toDiscard.id });

		expect((await listOpenCaptures(userA.id, group.id)).map((c) => c.id)).toEqual([open.id]);
		// Neither closed row was DELETED — the trail survives both endings.
		expect(await captureRows(group.id)).toHaveLength(3);
	});

	it('shows every member the whole group tray (§7.7 deduplication)', async () => {
		const group = await freshGroup();
		await addSecondMember(group.id);

		const mine = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner, about 1200 baht' }
		});

		// userB did not write it, and sees it anyway — that is the point.
		const seen = await listOpenCaptures(userB.id, group.id);
		expect(seen.map((c) => c.id)).toEqual([mine.id]);
		expect(seen[0].createdBy).toBe(userA.id);
	});

	it('refuses to list for a non-member (§12)', async () => {
		const group = await freshGroup();

		await expect(listOpenCaptures(userB.id, group.id)).rejects.toBeInstanceOf(GroupAccessError);
	});

	// ── 4. Resolve ────────────────────────────────────────────────────────────

	it('stamps a resolve and audits it, then refuses a second one', async () => {
		const group = await freshGroup();
		const txn = await recordTransaction(group.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner' }
		});

		const resolved = await resolveCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id,
			transactionId: txn.id
		});

		expect(resolved.resolvedTransactionId).toBe(txn.id);
		expect(resolved.resolvedAt).toBeInstanceOf(Date);
		expect(resolved.discardedAt).toBeNull();
		// The note is untouched: the row is stamped, not rewritten.
		expect(resolved.note).toBe('dinner');

		// A second attempt — the losing side of two members tapping "Record it".
		const error = await resolveCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id,
			transactionId: txn.id
		}).catch((e) => e);
		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('resolved');

		// Create + one resolve = 2 rows. The refused attempt added nothing.
		const entries = await captureAuditRows(group.id);
		expect(entries.map((e) => e.action).sort()).toEqual(['create', 'resolve']);
	});

	it('refuses a transaction from ANOTHER group and leaves the Capture open', async () => {
		const group = await freshGroup();
		const other = await freshGroup('other');
		const foreignTxn = await recordTransaction(other.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner' }
		});

		await expect(
			resolveCapture({
				userId: userA.id,
				groupId: group.id,
				captureId: capture.id,
				transactionId: foreignTxn.id
			})
		).rejects.toBeInstanceOf(TransactionNotFoundError);

		const [stored] = await captureRows(group.id);
		expect(stored.resolvedTransactionId).toBeNull();
		expect(stored.resolvedAt).toBeNull();
	});

	it("refuses another group's capture id as NOT FOUND (§12 don't leak)", async () => {
		const group = await freshGroup();
		const other = await freshGroup('other');
		const txn = await recordTransaction(group.id);
		const elsewhere = await createCapture({
			userId: userA.id,
			groupId: other.id,
			input: { note: 'other group' }
		});

		await expect(
			resolveCapture({
				userId: userA.id,
				groupId: group.id,
				captureId: elsewhere.id,
				transactionId: txn.id
			})
		).rejects.toBeInstanceOf(CaptureNotFoundError);
	});

	// ── 5. Discard ────────────────────────────────────────────────────────────

	it('soft-discards, audits it, and then refuses to resolve the same row', async () => {
		const group = await freshGroup();
		const txn = await recordTransaction(group.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'never mind' }
		});

		const discarded = await discardCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id
		});

		expect(discarded.discardedAt).toBeInstanceOf(Date);
		expect(discarded.resolvedAt).toBeNull();
		// SOFT: the row is still there, and so is its note.
		expect(await captureRows(group.id)).toHaveLength(1);

		const error = await resolveCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id,
			transactionId: txn.id
		}).catch((e) => e);
		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('discarded');

		const entries = await captureAuditRows(group.id);
		expect(entries.map((e) => e.action).sort()).toEqual(['create', 'discard']);
	});

	it('refuses a discard for a non-member and writes no audit row (§12)', async () => {
		const group = await freshGroup();
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner' }
		});

		await expect(
			discardCapture({ userId: userB.id, groupId: group.id, captureId: capture.id })
		).rejects.toBeInstanceOf(GroupAccessError);

		const [stored] = await captureRows(group.id);
		expect(stored.discardedAt).toBeNull();
		expect(await captureAuditRows(group.id)).toHaveLength(1); // the create only
	});
});
