// Real-DB HTTP-BOUNDARY integration tests for `/api/v1` (issue #25; PLAN §16.10).
//
// Every case here drives the app the way an agent does: a real `Request` with a
// real `Authorization: Bearer <key>` through the REAL `hooks.server.ts` guard, the
// REAL route handler, the REAL services and the LOCAL Postgres (see
// `./api-client.ts`). Nothing is mocked, so a break in ANY of those layers fails
// here. §16.10's boundary list, in order:
//
//   1. AUTH — missing / malformed / invalid / expired / revoked key all collapse to
//      the SAME generic 401 envelope (no enumeration signal).
//   2. SCOPE — a `read` key gets 403 `forbidden_scope` on EVERY write endpoint and
//      never mutates; the same key still reads fine.
//   3. 404 CONFLATION — another user's group and an absent id are byte-identical
//      404s on every group-scoped endpoint (existence never leaks).
//   4. PAGINATION — a keyset cursor walk yields every row exactly once, and stays
//      stable when a NEW transaction is inserted mid-walk.
//   5. §7.6 — a client-supplied `amountTotalSettlement` that disagrees with the
//      computed conversion is a 422 with field-level `details`.
//   6. SETTLE-UP — the sugar endpoint builds the CORRECT Transfer (settlement
//      currency, rate 1, debt-settlement category, payer=from, share=to) and the
//      group's balances net to zero.
//   7. AUDIT — create/update/delete/restore each write EXACTLY ONE row, a no-op
//      delete/restore writes NONE, and every row carries actor = user + `viaKey`
//      provenance (PLAN §16.2).
//
// Cleanup: `cleanupApiKeyRows()` (keys + their cascaded idempotency rows + the
// class rate-limit counters) then `cleanupSuiteRows()` (groups — which cascade the
// transactions + audit rows — then users). A second consecutive run is green.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog } from '$lib/server/db/audit-schema';
import { transactions } from '$lib/server/db/transactions-schema';
import { createGroup } from '$lib/server/groups';
import { createTransaction } from '$lib/server/transactions';
import { UNNAMED_API_KEY_LABEL, viaKeySummarySuffix } from '$lib/server/audit';
import { cleanupSuiteRows, createTestUser, db, describeIntegration } from './helpers';
import { apiCall, cleanupApiKeyRows, expireApiKey, mintApiKey, revokeApiKey } from './api-client';
import {
	createApiScenario,
	creatorMemberId,
	spendingInput,
	DEBT_SETTLEMENT_CATEGORY,
	SETTLEMENT_CURRENCY,
	SPENDING_CATEGORY,
	type ApiScenario
} from './api-fixtures';

/** The ONE 401 body the auth gate may ever emit (PLAN §16.5 — no enumeration). */
const GENERIC_401 = { error: { code: 'unauthorized', message: 'Authentication required.' } };
/** The ONE 404 body (absent and no-access are CONFLATED — PLAN §16.5 / §12). */
const GENERIC_404 = {
	error: { code: 'not_found', message: 'The requested resource was not found.' }
};

describeIntegration('integration: /api/v1 HTTP boundary (issue #25; PLAN §16.10)', () => {
	let s: ApiScenario;

	beforeEach(async () => {
		s = await createApiScenario('bnd');
	});

	afterEach(async () => {
		await cleanupApiKeyRows();
		await cleanupSuiteRows();
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	/** Create a transaction directly through the service (a fast, non-API seed). */
	async function seedSpending(title: string, amount = 9000): Promise<string> {
		return createTransaction({
			userId: s.user.id,
			groupId: s.group.id,
			input: spendingInput({
				payerId: s.alice,
				beneficiaryIds: [s.alice, s.bob],
				amount,
				title
			}),
			settlementCurrency: SETTLEMENT_CURRENCY
		});
	}

	/** This group's audit rows for one entity + action. */
	async function auditRows(entityId: string, action: string) {
		return db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.groupId, s.group.id),
					eq(auditLog.entityId, entityId),
					eq(auditLog.action, action)
				)
			);
	}

	/** Total audit rows for this group — the delta basis for "exactly one new row". */
	async function auditCount(): Promise<number> {
		const rows = await db.select().from(auditLog).where(eq(auditLog.groupId, s.group.id));
		return rows.length;
	}

	/** Rows in `transactions` for this group (deleted included). */
	async function txnCount(): Promise<number> {
		const rows = await db
			.select({ id: transactions.id })
			.from(transactions)
			.where(eq(transactions.groupId, s.group.id));
		return rows.length;
	}

	// ── 1. AUTH — every failure is the SAME generic 401 (§16.3, §16.5) ──────────

	describe('auth: every failure mode collapses to one generic 401', () => {
		it.each([
			['missing Authorization header', async () => ({})],
			['malformed scheme', async () => ({ headers: { authorization: 'Token abc' } })],
			['empty bearer credential', async () => ({ headers: { authorization: 'Bearer   ' } })],
			['an unknown key', async () => ({ key: 'pwm_test_definitely-not-a-real-key' })]
		])('%s → 401', async (_label, build) => {
			const res = await apiCall('GET', '/api/v1/groups', await build());
			expect(res.status).toBe(401);
			expect(res.body).toEqual(GENERIC_401);
		});

		it('an EXPIRED key → the same 401', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'expired');
			// It works before expiry — so the 401 below is caused by the expiry, not by a
			// broken fixture.
			expect((await apiCall('GET', '/api/v1/groups', { key: key.key })).status).toBe(200);

			await expireApiKey(key.id);
			const res = await apiCall('GET', '/api/v1/groups', { key: key.key });
			expect(res.status).toBe(401);
			expect(res.body).toEqual(GENERIC_401);
		});

		it('a REVOKED key → the same 401, immediately (§16.2)', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'revoked');
			expect((await apiCall('GET', '/api/v1/groups', { key: key.key })).status).toBe(200);

			await revokeApiKey(key.id);
			const res = await apiCall('GET', '/api/v1/groups', { key: key.key });
			expect(res.status).toBe(401);
			expect(res.body).toEqual(GENERIC_401);
		});

		it('the gate covers WRITE endpoints too (no unauthenticated mutation slips past)', async () => {
			const before = await txnCount();
			const res = await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions`, {
				body: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] })
			});
			expect(res.status).toBe(401);
			expect(res.body).toEqual(GENERIC_401);
			expect(await txnCount()).toBe(before);
		});
	});

	// ── 2. SCOPE — a read key can never write (§16.2) ───────────────────────────

	describe('scope: a read key gets 403 on every write endpoint', () => {
		let txnId: string;

		beforeEach(async () => {
			txnId = await seedSpending('Scope seed');
		});

		/** One write endpoint of the §16.2 guard's surface: how to call it, and with what. */
		type WriteCase = [
			label: string,
			target: () => readonly [method: string, path: string],
			body: () => unknown
		];

		it.each<WriteCase>([
			[
				'POST /transactions',
				() => ['POST', `/api/v1/groups/${s.group.id}/transactions`] as const,
				() => spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] })
			],
			[
				'PUT /transactions/{txid}',
				() => ['PUT', `/api/v1/groups/${s.group.id}/transactions/${txnId}`] as const,
				() => spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob], title: 'Edited' })
			],
			[
				'DELETE /transactions/{txid}',
				() => ['DELETE', `/api/v1/groups/${s.group.id}/transactions/${txnId}`] as const,
				() => undefined
			],
			[
				'POST /transactions/{txid}/restore',
				() => ['POST', `/api/v1/groups/${s.group.id}/transactions/${txnId}/restore`] as const,
				() => undefined
			],
			[
				'POST /settle-up',
				() => ['POST', `/api/v1/groups/${s.group.id}/settle-up`] as const,
				() => ({ from: s.bob, to: s.alice, amount: 4500 })
			]
		])('%s → 403 forbidden_scope', async (_label, target, body) => {
			const auditBefore = await auditCount();
			const [method, path] = target();
			const res = await apiCall(method, path, { key: s.readKey.key, body: body() });

			expect(res.status).toBe(403);
			expect(res.body).toEqual({
				error: { code: 'forbidden_scope', message: 'This API key does not have write access.' }
			});
			// The rejection is TOTAL: nothing was written, nothing was audited.
			expect(await txnCount()).toBe(1);
			expect(await auditCount()).toBe(auditBefore);
		});

		it('the same read key still READS every endpoint (write ⊇ read, §16.2)', async () => {
			for (const path of [
				'/api/v1/groups',
				'/api/v1/currencies',
				`/api/v1/groups/${s.group.id}`,
				`/api/v1/groups/${s.group.id}/members`,
				`/api/v1/groups/${s.group.id}/balances`,
				`/api/v1/groups/${s.group.id}/transactions`,
				`/api/v1/groups/${s.group.id}/transactions/${txnId}`
			]) {
				const res = await apiCall('GET', path, { key: s.readKey.key });
				expect(res.status, `GET ${path}`).toBe(200);
			}
		});

		it('a WRITE key may of course write (the 403 above is the scope, not a broken route)', async () => {
			const res = await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions`, {
				key: s.writeKey.key,
				body: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] })
			});
			expect(res.status).toBe(201);
		});
	});

	// ── 3. 404 CONFLATION — no-access is indistinguishable from absent ──────────

	describe('404: a group you cannot see is identical to one that does not exist', () => {
		let strangerGroupId: string;
		let strangerTxnId: string;

		beforeEach(async () => {
			// A SECOND user with their own group + transaction. Our key must not be able
			// to tell it apart from a made-up id.
			const stranger = await createTestUser('stranger');
			const group = await createGroup({
				userId: stranger.id,
				userName: stranger.name,
				name: 'Not yours',
				settlementCurrency: SETTLEMENT_CURRENCY
			});
			strangerGroupId = group.id;
			const strangerMember = await creatorMemberId(group.id, stranger.id);
			strangerTxnId = await createTransaction({
				userId: stranger.id,
				groupId: group.id,
				input: spendingInput({ payerId: strangerMember, beneficiaryIds: [strangerMember] }),
				settlementCurrency: SETTLEMENT_CURRENCY
			});
		});

		it.each([
			['GET  /groups/{gid}', (gid: string) => ['GET', `/api/v1/groups/${gid}`] as const],
			['GET  /members', (gid: string) => ['GET', `/api/v1/groups/${gid}/members`] as const],
			['GET  /balances', (gid: string) => ['GET', `/api/v1/groups/${gid}/balances`] as const],
			[
				'GET  /transactions',
				(gid: string) => ['GET', `/api/v1/groups/${gid}/transactions`] as const
			]
		])('%s — no-access and absent are the SAME 404 body', async (_label, target) => {
			const [method, foreignPath] = target(strangerGroupId);
			const [, absentPath] = target('grp_does_not_exist');

			const foreign = await apiCall(method, foreignPath, { key: s.readKey.key });
			const absent = await apiCall(method, absentPath, { key: s.readKey.key });

			expect(foreign.status).toBe(404);
			expect(absent.status).toBe(404);
			expect(foreign.body).toEqual(GENERIC_404);
			expect(foreign.body).toEqual(absent.body);
		});

		it("another user's TRANSACTION id, probed through OUR group, is a 404 (no cross-group read)", async () => {
			const res = await apiCall(
				'GET',
				`/api/v1/groups/${s.group.id}/transactions/${strangerTxnId}`,
				{ key: s.readKey.key }
			);
			expect(res.status).toBe(404);
			expect(res.body).toEqual(GENERIC_404);
		});

		it('WRITES against an inaccessible group are 404 too — and change nothing', async () => {
			const before = await db
				.select({ id: transactions.id })
				.from(transactions)
				.where(eq(transactions.groupId, strangerGroupId));

			const writes = [
				apiCall('POST', `/api/v1/groups/${strangerGroupId}/transactions`, {
					key: s.writeKey.key,
					body: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice] })
				}),
				apiCall('PUT', `/api/v1/groups/${strangerGroupId}/transactions/${strangerTxnId}`, {
					key: s.writeKey.key,
					body: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice] })
				}),
				apiCall('DELETE', `/api/v1/groups/${strangerGroupId}/transactions/${strangerTxnId}`, {
					key: s.writeKey.key
				}),
				apiCall('POST', `/api/v1/groups/${strangerGroupId}/settle-up`, {
					key: s.writeKey.key,
					body: { from: s.bob, to: s.alice, amount: 100 }
				})
			];
			for (const res of await Promise.all(writes)) {
				expect(res.status).toBe(404);
				expect(res.body).toEqual(GENERIC_404);
			}

			// The stranger's group is untouched: same row count, transaction still live.
			const after = await db
				.select({ id: transactions.id, deletedAt: transactions.deletedAt })
				.from(transactions)
				.where(eq(transactions.groupId, strangerGroupId));
			expect(after).toHaveLength(before.length);
			expect(after[0].deletedAt).toBeNull();
		});

		it('an unknown /api/v1 path is the same 404 envelope (the catch-all route)', async () => {
			const res = await apiCall('GET', '/api/v1/nope', { key: s.readKey.key });
			expect(res.status).toBe(404);
			expect(res.body).toEqual(GENERIC_404);
		});
	});

	// ── 4. PAGINATION — the keyset cursor is stable (§16.4) ─────────────────────

	describe('cursor pagination', () => {
		it('walks every row exactly once across pages', async () => {
			for (let i = 0; i < 5; i++) await seedSpending(`Txn ${i}`);

			const seen: string[] = [];
			let cursor: string | null = null;
			let pages = 0;

			do {
				const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
				const res = await apiCall<{
					data: { id: string }[];
					nextCursor: string | null;
				}>('GET', `/api/v1/groups/${s.group.id}/transactions${query}`, { key: s.readKey.key });
				expect(res.status).toBe(200);
				expect(res.body.data.length).toBeLessThanOrEqual(2);
				seen.push(...res.body.data.map((t) => t.id));
				cursor = res.body.nextCursor;
				pages++;
				expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
			} while (cursor);

			// 5 rows over pages of 2 → 3 pages, every id exactly once, no duplicates.
			expect(pages).toBe(3);
			expect(seen).toHaveLength(5);
			expect(new Set(seen).size).toBe(5);

			// …and the walk is the same total order the unpaginated list serves.
			const all = await apiCall<{ data: { id: string }[] }>(
				'GET',
				`/api/v1/groups/${s.group.id}/transactions?limit=100`,
				{ key: s.readKey.key }
			);
			expect(seen).toEqual(all.body.data.map((t) => t.id));
		});

		it('is STABLE under a concurrent insert: page 2 neither repeats nor skips a row', async () => {
			const ids: string[] = [];
			for (let i = 0; i < 4; i++) ids.push(await seedSpending(`Stable ${i}`));

			const page1 = await apiCall<{ data: { id: string }[]; nextCursor: string | null }>(
				'GET',
				`/api/v1/groups/${s.group.id}/transactions?limit=2`,
				{ key: s.readKey.key }
			);
			expect(page1.body.data).toHaveLength(2);
			const cursor = page1.body.nextCursor;
			expect(cursor).not.toBeNull();

			// A NEW transaction lands between the two page reads. A keyset cursor (unlike an
			// OFFSET) must not shift the window: the new row sorts BEFORE the cursor, so it
			// simply isn't in page 2 — and no already-served row is repeated or skipped.
			const inserted = await seedSpending('Inserted mid-walk');

			const page2 = await apiCall<{ data: { id: string }[]; nextCursor: string | null }>(
				'GET',
				`/api/v1/groups/${s.group.id}/transactions?limit=2&cursor=${encodeURIComponent(cursor!)}`,
				{ key: s.readKey.key }
			);
			const page2Ids = page2.body.data.map((t) => t.id);
			const page1Ids = page1.body.data.map((t) => t.id);

			expect(page2Ids).not.toContain(inserted);
			expect(page2Ids.some((id) => page1Ids.includes(id))).toBe(false);
			// Pages 1+2 = 4 distinct rows out of the original 4 (nothing skipped).
			expect(new Set([...page1Ids, ...page2Ids]).size).toBe(4);
			expect([...page1Ids, ...page2Ids].every((id) => ids.includes(id))).toBe(true);
		});

		it('an undecodable cursor is a 400 (never a silent restart from page 1)', async () => {
			await seedSpending('Cursor');
			const res = await apiCall('GET', `/api/v1/groups/${s.group.id}/transactions?cursor=%%%`, {
				key: s.readKey.key
			});
			expect(res.status).toBe(400);
			expect(res.body).toEqual({
				error: { code: 'bad_request', message: 'The pagination cursor is invalid.' }
			});
		});

		it('an out-of-range limit is a 422 with field-level details (not a silent clamp)', async () => {
			const res = await apiCall<{ error: { details: { fieldErrors: Record<string, string[]> } } }>(
				'GET',
				`/api/v1/groups/${s.group.id}/transactions?limit=101`,
				{ key: s.readKey.key }
			);
			expect(res.status).toBe(422);
			expect(res.body.error.details.fieldErrors).toHaveProperty('limit');
		});
	});

	// ── 5. §7.6 — a settlement-total mismatch is a 422 with field details ───────

	describe('§7.6 amountTotalSettlement mismatch', () => {
		/** A foreign-currency (THB → USD) spending input at an explicit rate. */
		function foreignInput(amountTotalSettlement: number) {
			return {
				type: 'spending' as const,
				title: 'Bangkok dinner',
				categoryId: SPENDING_CATEGORY,
				// ฿300.00 at 0.03 USD per THB → $9.00 = 900 settlement minor units.
				amountTotal: 30000,
				currency: 'THB',
				exchangeRate: '0.03',
				amountTotalSettlement,
				splitMode: 'equal' as const,
				payers: [{ memberId: s.alice, amountPaid: 30000 }],
				beneficiaries: [{ memberId: s.alice }, { memberId: s.bob }],
				items: [],
				charges: []
			};
		}

		it('a WRONG settlement total → 422 naming the field, and nothing is written', async () => {
			const before = await txnCount();
			const res = await apiCall<{
				error: { code: string; details: { fieldErrors: Record<string, string[]> } };
			}>('POST', `/api/v1/groups/${s.group.id}/transactions`, {
				key: s.writeKey.key,
				body: foreignInput(899) // computed conversion is 900
			});

			expect(res.status).toBe(422);
			expect(res.body.error.code).toBe('validation_error');
			// Field-level details are the whole point: an agent can self-correct.
			expect(res.body.error.details.fieldErrors).toHaveProperty('amountTotalSettlement');
			expect(await txnCount()).toBe(before);
		});

		it('the CORRECT computed conversion is accepted (the rule bites only on a mismatch)', async () => {
			const res = await apiCall<{
				amount: { amount: number; currency: string };
				settlementAmount: { amount: number; currency: string };
				isForeign: boolean;
			}>('POST', `/api/v1/groups/${s.group.id}/transactions`, {
				key: s.writeKey.key,
				body: foreignInput(900)
			});

			expect(res.status).toBe(201);
			expect(res.body.amount).toEqual({ amount: 30000, currency: 'THB' });
			expect(res.body.settlementAmount).toEqual({ amount: 900, currency: SETTLEMENT_CURRENCY });
			expect(res.body.isForeign).toBe(true);
		});

		it('a mismatch on PUT (full replace) is a 422 too', async () => {
			const txnId = await seedSpending('To edit');
			const res = await apiCall<{ error: { details: { fieldErrors: Record<string, string[]> } } }>(
				'PUT',
				`/api/v1/groups/${s.group.id}/transactions/${txnId}`,
				{ key: s.writeKey.key, body: foreignInput(1) }
			);
			expect(res.status).toBe(422);
			expect(res.body.error.details.fieldErrors).toHaveProperty('amountTotalSettlement');
		});
	});

	// ── 6. SETTLE-UP builds the correct Transfer (§8.4, §16.4) ──────────────────

	describe('settle-up', () => {
		it('records the exact Transfer that clears the debt, and balances net to zero', async () => {
			// Alice pays $90 for both → Bob owes her $45 (4500 minor units).
			await seedSpending('Dinner', 9000);

			const before = await apiCall<{ memberId: string; balance: { amount: number } }[]>(
				'GET',
				`/api/v1/groups/${s.group.id}/balances`,
				{ key: s.readKey.key }
			);
			expect(before.body.find((b) => b.memberId === s.bob)!.balance.amount).toBe(-4500);
			expect(before.body.find((b) => b.memberId === s.alice)!.balance.amount).toBe(4500);

			const res = await apiCall<{
				id: string;
				type: string;
				categoryId: string;
				splitMode: string;
				amount: { amount: number; currency: string };
				settlementAmount: { amount: number; currency: string };
				isForeign: boolean;
				payers: { memberId: string; amountPaid: { amount: number; currency: string } }[];
				shares: { memberId: string; amountOwed: { amount: number; currency: string } }[];
			}>('POST', `/api/v1/groups/${s.group.id}/settle-up`, {
				key: s.writeKey.key,
				body: { from: s.bob, to: s.alice, amount: 4500 }
			});

			expect(res.status).toBe(201);
			// The Transfer §16.4/§8.4 pins down: settlement currency at rate 1, the debt
			// settlement category, `from` as the sole payer and `to` as the sole share.
			expect(res.body.type).toBe('transfer');
			expect(res.body.categoryId).toBe(DEBT_SETTLEMENT_CATEGORY);
			expect(res.body.amount).toEqual({ amount: 4500, currency: SETTLEMENT_CURRENCY });
			expect(res.body.settlementAmount).toEqual({ amount: 4500, currency: SETTLEMENT_CURRENCY });
			expect(res.body.isForeign).toBe(false);
			expect(res.body.payers).toEqual([
				{ memberId: s.bob, amountPaid: { amount: 4500, currency: SETTLEMENT_CURRENCY } }
			]);
			expect(res.body.shares).toEqual([
				{ memberId: s.alice, amountOwed: { amount: 4500, currency: SETTLEMENT_CURRENCY } }
			]);

			// And the money story: everyone is square.
			const after = await apiCall<{ memberId: string; balance: { amount: number } }[]>(
				'GET',
				`/api/v1/groups/${s.group.id}/balances`,
				{ key: s.readKey.key }
			);
			expect(after.body.map((b) => b.balance.amount)).toEqual([0, 0]);
		});

		it('an unknown member id is a 422 (the create path re-validates against active members)', async () => {
			const before = await txnCount();
			const res = await apiCall('POST', `/api/v1/groups/${s.group.id}/settle-up`, {
				key: s.writeKey.key,
				body: { from: 'mem_ghost', to: s.alice, amount: 100 }
			});
			expect(res.status).toBe(422);
			expect(await txnCount()).toBe(before);
		});

		it('settling with yourself is a 422 with field-level details', async () => {
			const res = await apiCall<{ error: { details: { fieldErrors: Record<string, string[]> } } }>(
				'POST',
				`/api/v1/groups/${s.group.id}/settle-up`,
				{ key: s.writeKey.key, body: { from: s.alice, to: s.alice, amount: 100 } }
			);
			expect(res.status).toBe(422);
			expect(res.body.error.details.fieldErrors).toHaveProperty('to');
		});
	});

	// ── 7. AUDIT — one row per mutation, actor = user, `viaKey` provenance ──────

	describe('audit trail with viaKey provenance (§12.1, §16.2)', () => {
		const suffix = viaKeySummarySuffix({ keyId: 'ignored', keyName: 'writer' });

		/**
		 * Run an API mutation and assert it wrote EXACTLY ONE new audit row for the
		 * group, with the expected action, the USER as actor (never the key), and the
		 * §16.2 provenance: `metadata.viaKey` = the key id, `metadata.keyName` = its
		 * label, and the "(via API key '…')" summary suffix.
		 */
		async function expectOneViaKeyRow(
			expected: { action: string; entityId: string },
			mutation: () => Promise<{ status: number }>
		) {
			const before = await auditCount();
			const res = await mutation();
			expect(res.status).toBeLessThan(300);
			expect(await auditCount()).toBe(before + 1);

			const rows = await auditRows(expected.entityId, expected.action);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row.entityType).toBe('transaction');
			// The key acts AS the user — the actor is never the key (§16.2).
			expect(row.actorUserId).toBe(s.user.id);
			expect(row.metadata).toMatchObject({
				viaKey: s.writeKey.id,
				keyName: 'writer'
			});
			expect(row.summary.endsWith(suffix)).toBe(true);
			return row;
		}

		it('create / update / delete / restore each write EXACTLY ONE row, all carrying viaKey', async () => {
			const created = await apiCall<{ id: string }>(
				'POST',
				`/api/v1/groups/${s.group.id}/transactions`,
				{
					key: s.writeKey.key,
					body: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] })
				}
			);
			expect(created.status).toBe(201);
			const txnId = created.body.id;

			// The create's own row (already written by the call above) — assert it directly.
			const createRows = await auditRows(txnId, 'create');
			expect(createRows).toHaveLength(1);
			expect(createRows[0].actorUserId).toBe(s.user.id);
			expect(createRows[0].metadata).toMatchObject({ viaKey: s.writeKey.id, keyName: 'writer' });
			expect(createRows[0].summary.endsWith(suffix)).toBe(true);

			await expectOneViaKeyRow({ action: 'edit', entityId: txnId }, () =>
				apiCall('PUT', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
					key: s.writeKey.key,
					body: spendingInput({
						payerId: s.alice,
						beneficiaryIds: [s.alice, s.bob],
						title: 'Edited via key'
					})
				})
			);

			await expectOneViaKeyRow({ action: 'delete', entityId: txnId }, () =>
				apiCall('DELETE', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
					key: s.writeKey.key
				})
			);

			await expectOneViaKeyRow({ action: 'restore', entityId: txnId }, () =>
				apiCall('POST', `/api/v1/groups/${s.group.id}/transactions/${txnId}/restore`, {
					key: s.writeKey.key
				})
			);
		});

		it('a NO-OP delete / restore writes NO audit row', async () => {
			const txnId = await seedSpending('No-op');

			// First delete transitions state (1 row); the second is a no-op.
			await apiCall('DELETE', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
				key: s.writeKey.key
			});
			let before = await auditCount();
			const secondDelete = await apiCall(
				'DELETE',
				`/api/v1/groups/${s.group.id}/transactions/${txnId}`,
				{
					key: s.writeKey.key
				}
			);
			expect(secondDelete.status).toBe(200);
			expect(await auditCount()).toBe(before);
			expect(await auditRows(txnId, 'delete')).toHaveLength(1);

			// Same on the restore side: the first restores, the second is a no-op.
			await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions/${txnId}/restore`, {
				key: s.writeKey.key
			});
			before = await auditCount();
			const secondRestore = await apiCall(
				'POST',
				`/api/v1/groups/${s.group.id}/transactions/${txnId}/restore`,
				{ key: s.writeKey.key }
			);
			expect(secondRestore.status).toBe(200);
			expect(await auditCount()).toBe(before);
			expect(await auditRows(txnId, 'restore')).toHaveLength(1);
		});

		it('a WEB-session mutation carries NO provenance — that absence distinguishes the origins', async () => {
			// Same service, no `via` (what the web `actions` do).
			const txnId = await seedSpending('From the web');
			const rows = await auditRows(txnId, 'create');
			expect(rows).toHaveLength(1);
			expect(rows[0].summary).not.toContain('via API key');
			expect(rows[0].metadata).not.toHaveProperty('viaKey');
		});

		it('an UNNAMED key still writes a well-formed summary (metadata.keyName stays null)', async () => {
			// The plugin allows a null name; the summary falls back to the documented label.
			const key = await mintApiKey(s.user.id, 'write', 'temp');
			await db.execute(sql`update api_key set name = null where id = ${key.id}`);

			const created = await apiCall<{ id: string }>(
				'POST',
				`/api/v1/groups/${s.group.id}/transactions`,
				{
					key: key.key,
					body: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] })
				}
			);
			expect(created.status).toBe(201);

			const rows = await auditRows(created.body.id, 'create');
			expect(rows).toHaveLength(1);
			expect(rows[0].metadata).toMatchObject({ viaKey: key.id, keyName: null });
			expect(rows[0].summary).toContain(`(via API key '${UNNAMED_API_KEY_LABEL}')`);
		});
	});
});
