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
//   4. RECORDING A CAPTURE IS ONE TRANSACTION (issue #51; §7.7 "Resolving"). The
//      ledger insert and the `resolved_transaction_id` stamp either both commit or
//      neither does, and the ONLY way to show that is to make the stamp fail against
//      a real database and then look for the transaction it should have taken with
//      it. A stub cannot fail that way.
//   5. THE AMOUNT STAYS UNINTERPRETED. Stored in a currency that is NOT the
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
	countOpenCapturesByGroup,
	findOpenCapture,
	recordCaptureAsTransaction,
	resolveCapture,
	discardCapture,
	CaptureNotFoundError,
	CaptureNotOpenError,
	CaptureValidationError
} from '$lib/server/captures';
import {
	createTransaction,
	TransactionNotFoundError,
	TransactionValidationError
} from '$lib/server/transactions';
import { getGroupBalances } from '$lib/server/balances';
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

	// ── 3b. The unrecorded COUNT (issue #50; PLAN §7.7 "Recall (no push)") ────
	//
	// Push is out of scope (§1), so this count on `/groups` and the group overview
	// is the whole recall mechanism. Against a real DB because every claim is about
	// a real WHERE: "only open" cannot be shown by discarding a row in a stub.

	it('counts ONLY open rows — a resolved or discarded one stops counting', async () => {
		const group = await freshGroup();
		const txn = await recordTransaction(group.id);
		const args = { userId: userA.id, groupId: group.id };

		await createCapture({ ...args, input: { note: 'still open' } });
		const toResolve = await createCapture({ ...args, input: { note: 'about to be recorded' } });
		const toDiscard = await createCapture({ ...args, input: { note: 'about to be dropped' } });

		const count = async () =>
			(await countOpenCapturesByGroup({ userId: userA.id, groupIds: [group.id] })).get(group.id);

		expect(await count()).toBe(3);

		await resolveCapture({ ...args, captureId: toResolve.id, transactionId: txn.id });
		expect(await count()).toBe(2);

		// The one `resolved_at IS NULL` alone would keep counting forever.
		await discardCapture({ ...args, captureId: toDiscard.id });
		expect(await count()).toBe(1);

		// …and the count never disagrees with the tray it sits above.
		expect(await listOpenCaptures(userA.id, group.id)).toHaveLength(1);
	});

	it('counts every requested group in one call, and omits ones with nothing open', async () => {
		const withNotes = await freshGroup('count-a');
		const empty = await freshGroup('count-b');
		await createCapture({ userId: userA.id, groupId: withNotes.id, input: { note: 'one' } });
		await createCapture({ userId: userA.id, groupId: withNotes.id, input: { note: 'two' } });

		const counts = await countOpenCapturesByGroup({
			userId: userA.id,
			groupIds: [withNotes.id, empty.id]
		});

		expect(counts.get(withNotes.id)).toBe(2);
		expect(counts.has(empty.id)).toBe(false);
	});

	it('counts the WHOLE group tray for any member, not just their own notes', async () => {
		const group = await freshGroup();
		await addSecondMember(group.id);
		await createCapture({ userId: userA.id, groupId: group.id, input: { note: 'dinner' } });

		// userB wrote none of them and is told about all of them — deduplication (§7.7).
		const counts = await countOpenCapturesByGroup({ userId: userB.id, groupIds: [group.id] });
		expect(counts.get(group.id)).toBe(1);
	});

	it('reports NOTHING for a group the caller is not a member of (§12)', async () => {
		const group = await freshGroup();
		await createCapture({ userId: userA.id, groupId: group.id, input: { note: 'dinner' } });

		// A non-member gets no row rather than a count — the membership INNER JOIN is
		// the batched form of the same access check, and absence leaks nothing.
		const counts = await countOpenCapturesByGroup({ userId: userB.id, groupIds: [group.id] });
		expect(counts.has(group.id)).toBe(false);
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

	// ── 6. Recording a Capture (issue #51; PLAN §7.7 "Resolving", §7.4, §12.1) ──

	/** The creator's own member id — the payer/beneficiary the prefilled form uses. */
	async function creatorMemberId(groupId: string): Promise<string> {
		const [row] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, groupId), eq(members.userId, userA.id)));
		return row.id;
	}

	/** A minimal VALID equal-split spending payload, as the prefilled form submits it. */
	function equalSpendingInput(memberIds: string[], payerId: string, amount = 9000) {
		return {
			type: 'spending' as const,
			title: 'dinner at the night market',
			categoryId: SPENDING_CATEGORY,
			amountTotal: amount,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: amount,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: amount }],
			beneficiaries: memberIds.map((memberId) => ({ memberId })),
			items: [],
			charges: []
		};
	}

	/** This group's live transactions. */
	async function transactionRows(groupId: string) {
		return db.select().from(transactions).where(eq(transactions.groupId, groupId));
	}

	it('writes the transaction, the stamp and BOTH audit rows as one unit', async () => {
		const group = await freshGroup();
		const aliceId = await creatorMemberId(group.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner at the night market', amountMinor: 9000, currency: 'THB' }
		});

		const transactionId = await recordCaptureAsTransaction({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id,
			input: equalSpendingInput([aliceId], aliceId),
			settlementCurrency: 'THB'
		});

		// The transaction is REAL and ordinary — nothing marks it as having come from
		// a note.
		const [txn] = await transactionRows(group.id);
		expect(txn.id).toBe(transactionId);
		expect(txn.amountTotalSettlement).toBe(9000);

		// The Capture is STAMPED, not deleted: the trail from remembering to recording
		// survives, note and all (§7.7).
		const [stored] = await captureRows(group.id);
		expect(stored.resolvedTransactionId).toBe(transactionId);
		expect(stored.resolvedAt).toBeInstanceOf(Date);
		expect(stored.discardedAt).toBeNull();
		expect(stored.note).toBe('dinner at the night market');

		// One audit row for each half, both from this one write (§12.1).
		expect((await captureAuditRows(group.id)).map((e) => e.action).sort()).toEqual([
			'create',
			'resolve'
		]);
		const txnAudit = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.groupId, group.id), eq(auditLog.entityType, 'transaction')));
		expect(txnAudit.map((e) => e.action)).toEqual(['create']);

		// And it has left the tray and the count.
		expect(await listOpenCaptures(userA.id, group.id)).toHaveLength(0);
		const counts = await countOpenCapturesByGroup({ userId: userA.id, groupIds: [group.id] });
		expect(counts.get(group.id) ?? 0).toBe(0);
	});

	it('hits balances exactly as a directly-entered transaction does (§8)', async () => {
		// The point of ADR-0012: what a resolve produces is not a special kind of row.
		// Two identical payloads, one recorded from a note and one entered directly,
		// must move the ledger identically.
		const viaNote = await freshGroup('via-note');
		await addSecondMember(viaNote.id);
		const noteAlice = await creatorMemberId(viaNote.id);
		const [noteBob] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, viaNote.id), eq(members.userId, userB.id)));

		const capture = await createCapture({
			userId: userA.id,
			groupId: viaNote.id,
			input: { note: 'dinner at the night market', amountMinor: 9000, currency: 'THB' }
		});
		await recordCaptureAsTransaction({
			userId: userA.id,
			groupId: viaNote.id,
			captureId: capture.id,
			input: equalSpendingInput([noteAlice, noteBob.id], noteAlice),
			settlementCurrency: 'THB'
		});

		const direct = await freshGroup('direct');
		await addSecondMember(direct.id);
		const directAlice = await creatorMemberId(direct.id);
		const [directBob] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, direct.id), eq(members.userId, userB.id)));
		await createTransaction({
			userId: userA.id,
			groupId: direct.id,
			input: equalSpendingInput([directAlice, directBob.id], directAlice),
			settlementCurrency: 'THB'
		});

		const noteBalances = await getGroupBalances({ userId: userA.id, groupId: viaNote.id });
		const directBalances = await getGroupBalances({ userId: userA.id, groupId: direct.id });

		expect(noteBalances.map((b) => b.balance).sort((a, b) => a - b)).toEqual([-4500, 4500]);
		expect(noteBalances.map((b) => b.balance).sort((a, b) => a - b)).toEqual(
			directBalances.map((b) => b.balance).sort((a, b) => a - b)
		);
	});

	it('records NOTHING when the payload fails §7.4 — the note stays open', async () => {
		const group = await freshGroup();
		const aliceId = await creatorMemberId(group.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner', amountMinor: 9000, currency: 'THB' }
		});

		// The prefill is a starting point, not a trusted payload: the payer no longer
		// sums to the total, so the ordinary create refuses it.
		const broken = equalSpendingInput([aliceId], aliceId);
		broken.payers = [{ memberId: aliceId, amountPaid: 1 }];

		await expect(
			recordCaptureAsTransaction({
				userId: userA.id,
				groupId: group.id,
				captureId: capture.id,
				input: broken,
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionValidationError);

		expect(await transactionRows(group.id)).toHaveLength(0);
		const [stored] = await captureRows(group.id);
		expect(stored.resolvedTransactionId).toBeNull();
		expect(stored.resolvedAt).toBeNull();
		// Still in everyone's tray, which is exactly right: nothing was recorded.
		expect(await listOpenCaptures(userA.id, group.id)).toHaveLength(1);
	});

	it('rolls the transaction back when someone else recorded the note first', async () => {
		// The double-submit race, end to end. The stamp fails INSIDE the create's
		// transaction, so the loser must be left with no transaction at all — a
		// duplicate is precisely what the group-visible tray exists to prevent.
		const group = await freshGroup();
		const aliceId = await creatorMemberId(group.id);
		const first = await recordTransaction(group.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner' }
		});
		await resolveCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id,
			transactionId: first.id
		});

		const error = await recordCaptureAsTransaction({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id,
			input: equalSpendingInput([aliceId], aliceId),
			settlementCurrency: 'THB'
		}).catch((e) => e);

		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('resolved');
		// ONLY the pre-existing row: the second write left nothing behind.
		const rows = await transactionRows(group.id);
		expect(rows.map((r) => r.id)).toEqual([first.id]);
		// And the stamp still names the FIRST transaction.
		const [stored] = await captureRows(group.id);
		expect(stored.resolvedTransactionId).toBe(first.id);
	});

	it('rolls the transaction back when the note was discarded first', async () => {
		const group = await freshGroup();
		const aliceId = await creatorMemberId(group.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner' }
		});
		await discardCapture({ userId: userA.id, groupId: group.id, captureId: capture.id });

		const error = await recordCaptureAsTransaction({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id,
			input: equalSpendingInput([aliceId], aliceId),
			settlementCurrency: 'THB'
		}).catch((e) => e);

		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('discarded');
		expect(await transactionRows(group.id)).toHaveLength(0);
	});

	it('refuses a non-member, recording nothing (§12)', async () => {
		const group = await freshGroup();
		const aliceId = await creatorMemberId(group.id);
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner' }
		});

		await expect(
			recordCaptureAsTransaction({
				userId: userB.id,
				groupId: group.id,
				captureId: capture.id,
				input: equalSpendingInput([aliceId], aliceId),
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(GroupAccessError);

		expect(await transactionRows(group.id)).toHaveLength(0);
		const [stored] = await captureRows(group.id);
		expect(stored.resolvedAt).toBeNull();
	});

	// ── 7. The prefill read (`findOpenCapture`) ────────────────────────────────

	it('reads one open note for the prefill and leaves it untouched', async () => {
		// Abandoning the prefilled form must leave the note OPEN — opening the form is
		// a READ. There is no partial resolve to abandon.
		const group = await freshGroup();
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner', amountMinor: 120000, currency: 'JPY', capturedFor: '2026-08-01' }
		});

		const found = await findOpenCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: capture.id
		});

		expect(found?.note).toBe('dinner');
		// The three fields the form seeds from, byte-identical (§7.7, §7.1).
		expect(found?.amountMinor).toBe(120000);
		expect(found?.currency).toBe('JPY');
		expect(found?.capturedFor).toBe('2026-08-01');

		// Still open, still in the tray, still audited only once.
		expect(await listOpenCaptures(userA.id, group.id)).toHaveLength(1);
		expect(await captureAuditRows(group.id)).toHaveLength(1);
	});

	it("reads NULL for a note that is resolved, discarded, gone, or another group's", async () => {
		const group = await freshGroup();
		const other = await freshGroup('other');
		const txn = await recordTransaction(group.id);

		const resolved = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'already recorded' }
		});
		await resolveCapture({
			userId: userA.id,
			groupId: group.id,
			captureId: resolved.id,
			transactionId: txn.id
		});

		const discarded = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'given up on' }
		});
		await discardCapture({ userId: userA.id, groupId: group.id, captureId: discarded.id });

		const elsewhere = await createCapture({
			userId: userA.id,
			groupId: other.id,
			input: { note: 'other group' }
		});

		for (const captureId of [resolved.id, discarded.id, elsewhere.id, 'no-such-id']) {
			await expect(
				findOpenCapture({ userId: userA.id, groupId: group.id, captureId })
			).resolves.toBeNull();
		}
	});

	it('refuses the prefill read for a non-member (§12)', async () => {
		const group = await freshGroup();
		const capture = await createCapture({
			userId: userA.id,
			groupId: group.id,
			input: { note: 'dinner' }
		});

		await expect(
			findOpenCapture({ userId: userB.id, groupId: group.id, captureId: capture.id })
		).rejects.toBeInstanceOf(GroupAccessError);
	});
});
