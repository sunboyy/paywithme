// CONTRACT TEST — LIVE responses vs. the published OpenAPI schemas
// (issue #25; PLAN §16.9, §16.10).
//
// `src/lib/docs/openapi.contract.test.ts` validates the DTO MAPPERS' output from
// hand-written fixtures. This is the other half §16.10 asks for: the bodies the REAL
// routes return over the wire — produced by real services against a real Postgres,
// serialized through `json()`, read back off the `Response` — are validated against
// the SAME `#/components/schemas/*` the spec publishes (one shared Ajv config, see
// `createComponentSchemaChecker`). Every component schema is
// `additionalProperties: false`, so a field the spec doesn't declare fails here.
//
// Between them: the mapper can't drift from the spec (there), and the ROUTE can't
// drift from the mapper (here — e.g. a handler that wraps, renames, or adds a field
// on the way out would pass the fixture test and fail this one).
//
// It also holds the `/docs/api` QUICKSTART to the live API:
//   - its `curl` create body is POSTed (with the ids re-pointed at real members) and
//     must be ACCEPTED — the copy-pasted example provably works, not just "shape-checks";
//   - its documented 201 / groups / 422 bodies must have the SAME SHAPE as the live
//     ones, so the worked example cannot quietly go stale.

import { afterEach, beforeEach, expect, it, describe } from 'vitest';
import { createComponentSchemaChecker } from '$lib/docs/openapi';
import {
	QUICKSTART_CREATE_BODY,
	QUICKSTART_CREATE_RESPONSE,
	QUICKSTART_GROUPS_RESPONSE,
	QUICKSTART_ERROR_RESPONSE
} from '$lib/docs/api-quickstart';
import { createGroup } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import { createTransaction } from '$lib/server/transactions';
import { RATE_LIMITS } from '$lib/server/api/rate-limit';
import { cleanupSuiteRows, describeIntegration } from './helpers';
import { apiCall, cleanupApiKeyRows, mintApiKey } from './api-client';
import {
	createApiScenario,
	creatorMemberId,
	spendingInput,
	SETTLEMENT_CURRENCY,
	type ApiScenario
} from './api-fixtures';

const { check } = createComponentSchemaChecker();

/** Assert a LIVE response body matches the named component schema. */
function expectValid(schemaName: string, value: unknown): void {
	const result = check(schemaName, value);
	expect(result.ok, `${schemaName} mismatch: ${result.errors}`).toBe(true);
}

/** Assert every element of a live array body matches the schema (and the array is non-empty). */
function expectEachValid(schemaName: string, values: unknown): void {
	expect(Array.isArray(values)).toBe(true);
	const arr = values as unknown[];
	expect(arr.length).toBeGreaterThan(0);
	for (const value of arr) expectValid(schemaName, value);
}

/**
 * Assert `actual` and `documented` have the SAME STRUCTURE: identical key sets at
 * every object level (arrays compared on their first element). Values are ignored —
 * this is about the documented example not omitting, inventing, or renaming a field
 * relative to what the API really returns.
 */
function expectSameShape(actual: unknown, documented: unknown, path = '$'): void {
	if (Array.isArray(documented)) {
		expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
		const a = actual as unknown[];
		if (documented.length > 0 && a.length > 0) {
			expectSameShape(a[0], documented[0], `${path}[0]`);
		}
		return;
	}
	if (documented !== null && typeof documented === 'object') {
		expect(actual !== null && typeof actual === 'object', `${path} should be an object`).toBe(true);
		const documentedKeys = Object.keys(documented as object).sort();
		const actualKeys = Object.keys(actual as object).sort();
		expect(actualKeys, `${path} key set`).toEqual(documentedKeys);
		for (const key of documentedKeys) {
			expectSameShape(
				(actual as Record<string, unknown>)[key],
				(documented as Record<string, unknown>)[key],
				`${path}.${key}`
			);
		}
	}
}

describeIntegration('integration: /api/v1 live contract vs. OpenAPI (issue #25; §16.10)', () => {
	let s: ApiScenario;

	beforeEach(async () => {
		s = await createApiScenario('ctr');
	});

	afterEach(async () => {
		await cleanupApiKeyRows();
		await cleanupSuiteRows();
	});

	// ── 1. Every live SUCCESS body validates against its component schema ───────

	describe('live success responses', () => {
		it('the READ endpoints all serve spec-valid bodies', async () => {
			const txnId = await createTransaction({
				userId: s.user.id,
				groupId: s.group.id,
				input: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] }),
				settlementCurrency: SETTLEMENT_CURRENCY
			});
			const key = s.readKey.key;
			const gid = s.group.id;

			expectEachValid('Currency', (await apiCall('GET', '/api/v1/currencies', { key })).body);
			expectEachValid('Group', (await apiCall('GET', '/api/v1/groups', { key })).body);
			expectValid('Group', (await apiCall('GET', `/api/v1/groups/${gid}`, { key })).body);
			expectEachValid(
				'Member',
				(await apiCall('GET', `/api/v1/groups/${gid}/members`, { key })).body
			);
			expectEachValid(
				'Balance',
				(await apiCall('GET', `/api/v1/groups/${gid}/balances`, { key })).body
			);

			// The one paginated envelope — validated whole (`data` + `nextCursor`).
			const page = await apiCall('GET', `/api/v1/groups/${gid}/transactions?limit=1`, { key });
			expectValid('TransactionPage', page.body);

			expectValid(
				'TransactionDetail',
				(await apiCall('GET', `/api/v1/groups/${gid}/transactions/${txnId}`, { key })).body
			);
		});

		it('a page WITH a nextCursor is spec-valid too (the cursor is a plain string)', async () => {
			for (let i = 0; i < 2; i++) {
				await createTransaction({
					userId: s.user.id,
					groupId: s.group.id,
					input: spendingInput({
						payerId: s.alice,
						beneficiaryIds: [s.alice, s.bob],
						title: `Page ${i}`
					}),
					settlementCurrency: SETTLEMENT_CURRENCY
				});
			}
			const page = await apiCall<{ nextCursor: string | null }>(
				'GET',
				`/api/v1/groups/${s.group.id}/transactions?limit=1`,
				{ key: s.readKey.key }
			);
			expect(page.body.nextCursor).toEqual(expect.any(String));
			expectValid('TransactionPage', page.body);
		});

		it('every WRITE endpoint serves a spec-valid TransactionDetail', async () => {
			const key = s.writeKey.key;
			const gid = s.group.id;

			const created = await apiCall<{ id: string }>('POST', `/api/v1/groups/${gid}/transactions`, {
				key,
				body: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] })
			});
			expect(created.status).toBe(201);
			expectValid('TransactionDetail', created.body);
			const txnId = created.body.id;

			const updated = await apiCall('PUT', `/api/v1/groups/${gid}/transactions/${txnId}`, {
				key,
				body: spendingInput({
					payerId: s.alice,
					beneficiaryIds: [s.alice, s.bob],
					title: 'Edited'
				})
			});
			expectValid('TransactionDetail', updated.body);

			// A SOFT-DELETED detail (deletedAt is a non-null string) must still validate.
			const deleted = await apiCall<{ deletedAt: string | null }>(
				'DELETE',
				`/api/v1/groups/${gid}/transactions/${txnId}`,
				{ key }
			);
			expect(deleted.body.deletedAt).toEqual(expect.any(String));
			expectValid('TransactionDetail', deleted.body);

			const restored = await apiCall<{ deletedAt: string | null }>(
				'POST',
				`/api/v1/groups/${gid}/transactions/${txnId}/restore`,
				{ key }
			);
			expect(restored.body.deletedAt).toBeNull();
			expectValid('TransactionDetail', restored.body);

			const settled = await apiCall('POST', `/api/v1/groups/${gid}/settle-up`, {
				key,
				body: { from: s.bob, to: s.alice, amount: 4500 }
			});
			expect(settled.status).toBe(201);
			expectValid('TransactionDetail', settled.body);
		});
	});

	// ── 2. Every live ERROR body validates against the `Error` schema (§16.5) ───

	describe('live error envelopes', () => {
		it('401 / 403 / 404 / 400 / 422 / 409 all match the Error schema', async () => {
			const gid = s.group.id;
			const txnId = await createTransaction({
				userId: s.user.id,
				groupId: gid,
				input: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] }),
				settlementCurrency: SETTLEMENT_CURRENCY
			});
			const body = spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] });

			const unauthorized = await apiCall('GET', '/api/v1/groups', {});
			const forbidden = await apiCall('POST', `/api/v1/groups/${gid}/transactions`, {
				key: s.readKey.key,
				body
			});
			const notFound = await apiCall('GET', '/api/v1/groups/nope', { key: s.readKey.key });
			const badCursor = await apiCall('GET', `/api/v1/groups/${gid}/transactions?cursor=%%%`, {
				key: s.readKey.key
			});
			const invalid = await apiCall('POST', `/api/v1/groups/${gid}/settle-up`, {
				key: s.writeKey.key,
				body: { from: s.alice, to: s.alice, amount: 1 }
			});
			// 409: same Idempotency-Key, different body.
			await apiCall('POST', `/api/v1/groups/${gid}/transactions`, {
				key: s.writeKey.key,
				body,
				idempotencyKey: 'contract-01'
			});
			const conflict = await apiCall('POST', `/api/v1/groups/${gid}/transactions`, {
				key: s.writeKey.key,
				body: { ...body, title: 'Different' },
				idempotencyKey: 'contract-01'
			});

			const cases: [number, { status: number; body: unknown }][] = [
				[401, unauthorized],
				[403, forbidden],
				[404, notFound],
				[400, badCursor],
				[422, invalid],
				[409, conflict]
			];
			for (const [expected, res] of cases) {
				expect(res.status, `expected ${expected}`).toBe(expected);
				expectValid('Error', res.body);
			}

			// Keep `txnId` meaningful: the seeded txn is what makes the 403 above a real
			// mutation attempt on a populated group, not an empty-state fluke.
			expect(txnId).toEqual(expect.any(String));
		});

		it('the live 429 envelope (+ Retry-After) matches the Error schema', async () => {
			const key = await mintApiKey(s.user.id, 'write', 'contract burst');
			const txnId = await createTransaction({
				userId: s.user.id,
				groupId: s.group.id,
				input: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] }),
				settlementCurrency: SETTLEMENT_CURRENCY
			});

			// Exhaust the write window with idempotent DELETEs, then trip it.
			for (let i = 0; i < RATE_LIMITS.write.max; i++) {
				await apiCall('DELETE', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
					key: key.key
				});
			}
			const limited = await apiCall(
				'DELETE',
				`/api/v1/groups/${s.group.id}/transactions/${txnId}`,
				{
					key: key.key
				}
			);

			expect(limited.status).toBe(429);
			expect(limited.headers.get('Retry-After')).toEqual(expect.any(String));
			expectValid('Error', limited.body);
		});
	});

	// ── 3. The /docs/api quickstart, held to the LIVE API (§16.9) ───────────────

	describe('the /docs/api quickstart', () => {
		it('its curl create body is ACCEPTED verbatim by the live endpoint', async () => {
			// The quickstart's body is a THB group with `exchangeRate: '1'`, so recreate that
			// group shape and re-point ONLY the two member ids (`mem_ada` / `mem_grace` are
			// illustrative). Everything else — amounts, currency, rate, splitMode, the §7.6
			// settlement total — is sent EXACTLY as documented.
			const group = await createGroup({
				userId: s.user.id,
				userName: s.user.name,
				name: 'Tokyo trip',
				settlementCurrency: QUICKSTART_CREATE_BODY.currency
			});
			const ada = await creatorMemberId(group.id, s.user.id);
			const grace = (
				await addMember({ userId: s.user.id, groupId: group.id, displayName: 'Grace' })
			).id;

			const body = {
				...QUICKSTART_CREATE_BODY,
				payers: QUICKSTART_CREATE_BODY.payers.map((p) => ({ ...p, memberId: ada })),
				beneficiaries: [{ memberId: ada }, { memberId: grace }]
			};

			const res = await apiCall<Record<string, unknown>>(
				'POST',
				`/api/v1/groups/${group.id}/transactions`,
				{ key: s.writeKey.key, body, idempotencyKey: 'ramen-2026-05-04-01' }
			);

			// The documented request really works — and returns the documented 201.
			expect(res.status).toBe(201);
			expectValid('TransactionDetail', res.body);
			// …and the documented 201 EXAMPLE has the same shape as the real one.
			expectSameShape(res.body, QUICKSTART_CREATE_RESPONSE);
			// The money the quickstart promises, to the minor unit (฿900.00 split two ways).
			// Compared as a SET — the share rows carry no documented ordering.
			expect(res.body.amount).toEqual({ amount: 90000, currency: 'THB' });
			expect(res.body.shares).toHaveLength(2);
			expect(res.body.shares).toEqual(
				expect.arrayContaining([
					{ memberId: ada, amountOwed: { amount: 45000, currency: 'THB' } },
					{ memberId: grace, amountOwed: { amount: 45000, currency: 'THB' } }
				])
			);

			// The documented Idempotency-Key retry story: same key + same body replays.
			const replay = await apiCall<Record<string, unknown>>(
				'POST',
				`/api/v1/groups/${group.id}/transactions`,
				{ key: s.writeKey.key, body, idempotencyKey: 'ramen-2026-05-04-01' }
			);
			expect(replay.status).toBe(201);
			expect(replay.body).toEqual(res.body);
		});

		it('its groups-list example has the same shape as the live GET /groups', async () => {
			const res = await apiCall('GET', '/api/v1/groups', { key: s.readKey.key });
			expectSameShape(res.body, QUICKSTART_GROUPS_RESPONSE);
		});

		it('its 422 example is the envelope the live §7.6 mismatch really returns', async () => {
			// The quickstart shows a settlement-total mismatch as THE error an agent will
			// hit. Produce it for real and hold the documented body to it.
			const res = await apiCall<{
				error: { code: string; details: { fieldErrors: Record<string, string[]> } };
			}>('POST', `/api/v1/groups/${s.group.id}/transactions`, {
				key: s.writeKey.key,
				body: {
					...spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob], amount: 30000 }),
					currency: 'THB',
					exchangeRate: '0.03',
					amountTotalSettlement: 1 // computed conversion is 900
				}
			});

			expect(res.status).toBe(422);
			expectValid('Error', res.body);
			expectSameShape(res.body, QUICKSTART_ERROR_RESPONSE);
			expect(res.body.error.code).toBe(QUICKSTART_ERROR_RESPONSE.error.code);
			// The documented `details.fieldErrors` key is the one the API really names.
			expect(Object.keys(res.body.error.details.fieldErrors)).toContain('amountTotalSettlement');
		});
	});
});
