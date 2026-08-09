// Real-DB HTTP-BOUNDARY tests for the CUSTOM-CURRENCY vocabulary on `/api/v1`
// (issue #68; PLAN §7.5.2 "REST surface", §13, §16.4; ADR-0014 decisions 5, 7, 8).
//
// The route-colocated unit tests fake the `currencies` rows. This suite asks the
// question those cannot: against a REAL group with a REAL custom currency, does a
// client that only ever sees display codes get a working, closed loop?
//
//   1. ROUND TRIP — `GET` a custom-currency transaction, `PUT` the body straight
//      back, and the STORED `transactions.currency` is still the same opaque row key.
//      This is the property that was broken before #68 and the reason the ADR was
//      amended: a full-replacement `PUT` must accept what its own `GET` serves.
//   2. CREATE by display code — a transaction can be recorded in `BEER` without the
//      client ever learning the row key.
//   3. ONE INDISTINGUISHABLE FAILURE — another group's display code, an unknown
//      code, and the opaque key itself all produce the SAME 422 body. The opaque one
//      is the load-bearing case: accepting it would make an internal identifier a
//      permanent part of the contract (ADR-0014 decision 8, "why not expose it").
//   4. SEEDED REGRESSION — a pre-#68 body (ISO code) is unaffected.
//   5. `GET /groups/{gid}/currencies` — the seeded table plus this group's OWN rows,
//      never another group's, membership required, and the global `GET /currencies`
//      still the static seeded table.
//   6. NO OPAQUE CODE ANYWHERE — every response body in the whole flow is scanned.
//
// Cleanup: `transactions.currency → currencies.code` is RESTRICT, so this suite's
// ledger rows go before its custom currencies; then the keys, then the group/users.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { createCustomCurrency } from '$lib/server/currencies';
import { transactions } from '$lib/server/db/transactions-schema';
import { UNSUPPORTED_CURRENCY_MESSAGE } from '$lib/schemas/currency';
import { CURRENCIES } from '$lib/money';
import { cleanupSuiteRows, createTestUser, db, describeIntegration, IT_PREFIX } from './helpers';
import { apiCall, cleanupApiKeyRows, mintApiKey, type TestApiKey } from './api-client';
import { createApiScenario, SPENDING_CATEGORY, type ApiScenario } from './api-fixtures';

/** The one 404 body (absent and no-access are CONFLATED — PLAN §16.5 / §12). */
const GENERIC_404 = {
	error: { code: 'not_found', message: 'The requested resource was not found.' }
};

interface MoneyDto {
	amount: number;
	currency: string;
}
interface TransactionDetailDto {
	id: string;
	amount: MoneyDto;
	settlementAmount: MoneyDto;
	payers: { memberId: string; amountPaid: MoneyDto }[];
}
interface CurrencyDto {
	code: string;
	exponent: number;
	symbol: string;
}

describeIntegration('integration: /api/v1 custom-currency vocabulary (issue #68)', () => {
	let s: ApiScenario;
	/** The opaque row key `BEER` is stored under — known to the SERVER only. */
	let beerCode: string;

	beforeEach(async () => {
		s = await createApiScenario('cur');
		const row = await createCustomCurrency({
			userId: s.user.id,
			groupId: s.group.id,
			input: { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 0 }
		});
		beerCode = row.code;
	});

	afterEach(async () => {
		await cleanupApiKeyRows();
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

	/**
	 * A spending of `3 BEER` at 250 USD-cents each — so the §7.6 settlement total is
	 * 750.00 in the group's settlement currency. `currency` is the DISPLAY code,
	 * which is the only currency vocabulary a client of this API has.
	 */
	function beerBody(currency = 'BEER', title = 'Three beers') {
		return {
			type: 'spending' as const,
			title,
			categoryId: SPENDING_CATEGORY,
			amountTotal: 3,
			currency,
			exchangeRate: '250',
			amountTotalSettlement: 75000,
			splitMode: 'equal' as const,
			payers: [{ memberId: s.alice, amountPaid: 3 }],
			beneficiaries: [{ memberId: s.alice }, { memberId: s.bob }],
			items: [],
			charges: []
		};
	}

	/** The `currency` column as STORED — the assertion the wire cannot make. */
	async function storedCurrency(txnId: string): Promise<string> {
		const [row] = await db
			.select({ currency: transactions.currency })
			.from(transactions)
			.where(eq(transactions.id, txnId));
		return row.currency;
	}

	// ── 1 + 2. Create by display code, then read it back and write it back ──────

	it('POST records a transaction in a group-defined currency, named by DISPLAY code', async () => {
		const created = await apiCall<TransactionDetailDto>(
			'POST',
			`/api/v1/groups/${s.group.id}/transactions`,
			{ key: s.writeKey.key, body: beerBody() }
		);

		expect(created.status).toBe(201);
		// The wire speaks display code, in both directions.
		expect(created.body.amount).toEqual({ amount: 3, currency: 'BEER' });
		// …and the LEDGER stored the opaque row key, which the client never saw.
		expect(await storedCurrency(created.body.id)).toBe(beerCode);
		// The 0-exponent currency is not silently rescaled: 3 beers, not 300.
		expect(created.body.amount.amount).toBe(3);
		// Settlement stays in the seeded currency (ADR-0014 decision 1).
		expect(created.body.settlementAmount.currency).toBe(s.group.settlementCurrency);
	});

	it('GET → PUT round trip: the body comes back unchanged and the stored currency does not move', async () => {
		const created = await apiCall<TransactionDetailDto>(
			'POST',
			`/api/v1/groups/${s.group.id}/transactions`,
			{ key: s.writeKey.key, body: beerBody() }
		);
		const txnId = created.body.id;

		// READ. This is all a client has: a display code.
		const got = await apiCall<TransactionDetailDto>(
			'GET',
			`/api/v1/groups/${s.group.id}/transactions/${txnId}`,
			{ key: s.readKey.key }
		);
		expect(got.status).toBe(200);
		expect(got.body.amount.currency).toBe('BEER');

		// WRITE IT BACK — the same code the read served, with one unrelated edit so the
		// PUT is a real replacement and not a no-op.
		const put = await apiCall<TransactionDetailDto>(
			'PUT',
			`/api/v1/groups/${s.group.id}/transactions/${txnId}`,
			{ key: s.writeKey.key, body: { ...beerBody(got.body.amount.currency), title: 'Four beers' } }
		);

		expect(put.status).toBe(200);
		expect(put.body.amount).toEqual({ amount: 3, currency: 'BEER' });
		// THE CLAIM: the round trip did not move the transaction's currency.
		expect(await storedCurrency(txnId)).toBe(beerCode);
	});

	// ── 3. One indistinguishable failure for every bad code ─────────────────────

	it('the OPAQUE row key is REJECTED on the write path, exactly like an unknown code', async () => {
		// A client that somehow learned `cur_…` must gain nothing from it: the write
		// vocabulary is display code only, so the internal id never becomes a contract.
		const opaque = await apiCall(`POST`, `/api/v1/groups/${s.group.id}/transactions`, {
			key: s.writeKey.key,
			body: beerBody(beerCode)
		});
		const unknown = await apiCall(`POST`, `/api/v1/groups/${s.group.id}/transactions`, {
			key: s.writeKey.key,
			body: beerBody('XXX')
		});

		expect(opaque.status).toBe(422);
		expect(opaque.body).toEqual(unknown.body);
		expect(opaque.body).toMatchObject({
			error: {
				code: 'validation_error',
				details: { fieldErrors: { currency: [UNSUPPORTED_CURRENCY_MESSAGE] } }
			}
		});
	});

	it("ANOTHER group's display code fails with the same body — nothing leaks about it", async () => {
		// A second group, owned by the same user, that defines its own `RUPEE`. Same
		// user, so this is purely about currency scoping and not about access.
		const other = await createGroup({
			userId: s.user.id,
			userName: s.user.name,
			name: `${IT_PREFIX}other`,
			settlementCurrency: 'USD'
		});
		await createCustomCurrency({
			userId: s.user.id,
			groupId: other.id,
			input: { displayCode: 'RUPEE', name: 'Rupee', symbol: '₹', exponent: 2 }
		});

		const foreign = await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions`, {
			key: s.writeKey.key,
			body: beerBody('RUPEE')
		});
		const unknown = await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions`, {
			key: s.writeKey.key,
			body: beerBody('XXX')
		});

		expect(foreign.status).toBe(422);
		// Byte-identical: "exists in another group" and "does not exist" are one answer.
		expect(foreign.body).toEqual(unknown.body);
	});

	// ── 4. The seeded regression ────────────────────────────────────────────────

	it('a SEEDED-currency write body behaves exactly as it did before #68', async () => {
		const amount = 9000;
		const created = await apiCall<TransactionDetailDto>(
			'POST',
			`/api/v1/groups/${s.group.id}/transactions`,
			{
				key: s.writeKey.key,
				body: {
					...beerBody(),
					title: 'Dinner',
					amountTotal: amount,
					currency: s.group.settlementCurrency,
					exchangeRate: '1',
					amountTotalSettlement: amount,
					payers: [{ memberId: s.alice, amountPaid: amount }]
				}
			}
		);

		expect(created.status).toBe(201);
		expect(created.body.amount).toEqual({ amount, currency: s.group.settlementCurrency });
		// `code == display_code` for a seeded row, so the stored value is the ISO code.
		expect(await storedCurrency(created.body.id)).toBe(s.group.settlementCurrency);
	});

	it('settle-up is unaffected: it records the SETTLEMENT currency, never a custom one', async () => {
		// The settle-up body carries no currency at all — the Transfer is built from the
		// group row, and a settlement currency is always seeded (ADR-0014 decision 1), so
		// there is nothing to translate. Pinned in a group that HAS a custom currency, so
		// the claim is tested where it could actually go wrong.
		const settled = await apiCall<TransactionDetailDto>(
			'POST',
			`/api/v1/groups/${s.group.id}/settle-up`,
			{ key: s.writeKey.key, body: { from: s.bob, to: s.alice, amount: 2500 } }
		);

		expect(settled.status).toBe(201);
		expect(settled.body.amount).toEqual({ amount: 2500, currency: s.group.settlementCurrency });
		expect(await storedCurrency(settled.body.id)).toBe(s.group.settlementCurrency);
	});

	// ── 5. The group-scoped currency table ──────────────────────────────────────

	it("GET /groups/{gid}/currencies serves the seeded table PLUS this group's own rows", async () => {
		const res = await apiCall<CurrencyDto[]>('GET', `/api/v1/groups/${s.group.id}/currencies`, {
			key: s.readKey.key
		});

		expect(res.status).toBe(200);
		const codes = res.body.map((c) => c.code);
		// Every seeded currency is there, in the §7.5.1 order, ahead of the group's own.
		expect(codes.slice(0, CURRENCIES.length)).toEqual(CURRENCIES.map((c) => c.code));
		expect(codes).toContain('BEER');
		// With the exponent a client needs to interpret `{ amount: 3, currency: 'BEER' }`.
		expect(res.body.find((c) => c.code === 'BEER')).toEqual({
			code: 'BEER',
			exponent: 0,
			symbol: '🍺'
		});
		// The opaque key is not served — this endpoint exists to avoid publishing it.
		expect(JSON.stringify(res.body)).not.toContain('cur_');
	});

	it("never serves ANOTHER group's custom currency", async () => {
		const other = await createGroup({
			userId: s.user.id,
			userName: s.user.name,
			name: `${IT_PREFIX}other2`,
			settlementCurrency: 'USD'
		});
		await createCustomCurrency({
			userId: s.user.id,
			groupId: other.id,
			input: { displayCode: 'RUPEE', name: 'Rupee', symbol: '₹', exponent: 2 }
		});

		const mine = await apiCall<CurrencyDto[]>('GET', `/api/v1/groups/${s.group.id}/currencies`, {
			key: s.readKey.key
		});
		const theirs = await apiCall<CurrencyDto[]>('GET', `/api/v1/groups/${other.id}/currencies`, {
			key: s.readKey.key
		});

		expect(mine.body.map((c) => c.code)).toContain('BEER');
		expect(mine.body.map((c) => c.code)).not.toContain('RUPEE');
		expect(theirs.body.map((c) => c.code)).toContain('RUPEE');
		expect(theirs.body.map((c) => c.code)).not.toContain('BEER');
	});

	it("requires membership: a stranger's key gets the CONFLATED 404, like an absent group", async () => {
		const stranger = await createTestUser('strn');
		const strangerKey: TestApiKey = await mintApiKey(stranger.id, 'read', 'stranger');

		const noAccess = await apiCall('GET', `/api/v1/groups/${s.group.id}/currencies`, {
			key: strangerKey.key
		});
		const absent = await apiCall('GET', `/api/v1/groups/no-such-group/currencies`, {
			key: strangerKey.key
		});

		expect(noAccess.status).toBe(404);
		expect(noAccess.body).toEqual(GENERIC_404);
		// Indistinguishable from a group that does not exist (§16.5 / §12).
		expect(absent.body).toEqual(noAccess.body);
	});

	it('the GLOBAL GET /currencies is unchanged — seeded only, no group rows', async () => {
		// Regression on ADR-0014 decision 7 / §16.4: the global table takes no group and
		// must not have grown the group-scoped rows this suite created.
		const res = await apiCall<CurrencyDto[]>('GET', '/api/v1/currencies', { key: s.readKey.key });

		expect(res.status).toBe(200);
		expect(res.body.map((c) => c.code)).toEqual(CURRENCIES.map((c) => c.code));
		expect(res.body.map((c) => c.code)).not.toContain('BEER');
	});

	// ── 6. The opaque code appears NOWHERE ──────────────────────────────────────

	it('no response body in the whole flow contains the opaque row key', async () => {
		const created = await apiCall<TransactionDetailDto>(
			'POST',
			`/api/v1/groups/${s.group.id}/transactions`,
			{ key: s.writeKey.key, body: beerBody() }
		);
		const txnId = created.body.id;
		const bodies = [
			created.body,
			(await apiCall('GET', `/api/v1/groups/${s.group.id}/transactions`, { key: s.readKey.key }))
				.body,
			(
				await apiCall('GET', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
					key: s.readKey.key
				})
			).body,
			(await apiCall('GET', `/api/v1/groups/${s.group.id}/currencies`, { key: s.readKey.key }))
				.body,
			(
				await apiCall('PUT', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
					key: s.writeKey.key,
					body: { ...beerBody(), title: 'Five beers' }
				})
			).body,
			(
				await apiCall('DELETE', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
					key: s.writeKey.key
				})
			).body,
			(
				await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions/${txnId}/restore`, {
					key: s.writeKey.key
				})
			).body,
			// And the 422 for a bad code says nothing the client could retry WITH.
			(
				await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions`, {
					key: s.writeKey.key,
					body: beerBody('NOPE')
				})
			).body
		];

		for (const body of bodies) {
			expect(JSON.stringify(body)).not.toContain('cur_');
		}
	});
});
