// Real-DB HTTP-BOUNDARY integration tests — IDEMPOTENCY + RATE LIMITS
// (issue #25; PLAN §16.6, §16.7, §16.10).
//
// The unit tests for these two features inject a stub store / a fake clock. This
// suite proves the SAME rules through the real wire: a real key, the real
// `Idempotency-Key` header, the real `idempotency_key` + `api_key_class_rate_limit`
// tables, and the real transaction + audit writes behind them.
//
//   IDEMPOTENCY (§16.6) — same key + same body REPLAYS the stored response with no
//   duplicate transaction and no duplicate audit row; same key + a DIFFERENT body is
//   a 409 `key_reused`; the store is scoped to the CALLING key, so the same header
//   value from another key is not a replay; two concurrent identical retries create
//   AT MOST ONE transaction.
//
//   RATE LIMITS (§16.7) — the two per-key counters are exhausted for real: the
//   100th read passes and the 101st returns the `rate_limited` envelope + a
//   `Retry-After` header; the 20th write passes and the 21st is limited. The two
//   counters are INDEPENDENT (an exhausted write budget still allows reads), and a
//   read key hitting a write endpoint gets 403 WITHOUT consuming the write budget.
//
// Every rate-limit test mints its OWN key so the counters can't bleed between tests
// (and stays under the plugin's 150/60s tier-1 backstop).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog } from '$lib/server/db/audit-schema';
import { transactions } from '$lib/server/db/transactions-schema';
import { idempotencyKey as idempotencyKeyTable } from '$lib/server/db/idempotency-schema';
import { apiKeyClassRateLimit } from '$lib/server/db/api-key-class-rate-limit-schema';
import { createTransaction } from '$lib/server/transactions';
import { RATE_LIMITS, rateLimitKey } from '$lib/server/api/rate-limit';
import { cleanupSuiteRows, db, describeIntegration } from './helpers';
import { apiCall, cleanupApiKeyRows, mintApiKey } from './api-client';
import {
	createApiScenario,
	spendingInput,
	SETTLEMENT_CURRENCY,
	type ApiScenario
} from './api-fixtures';

describeIntegration('integration: /api/v1 idempotency + rate limits (issue #25)', () => {
	let s: ApiScenario;

	beforeEach(async () => {
		s = await createApiScenario('idem');
	});

	afterEach(async () => {
		await cleanupApiKeyRows();
		await cleanupSuiteRows();
	});

	/** Rows in `transactions` for this group. */
	async function txnCount(): Promise<number> {
		const rows = await db
			.select({ id: transactions.id })
			.from(transactions)
			.where(eq(transactions.groupId, s.group.id));
		return rows.length;
	}

	/** `create` audit rows for this group (the "no duplicate audit row" assertion). */
	async function createAuditCount(): Promise<number> {
		const rows = await db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(and(eq(auditLog.groupId, s.group.id), eq(auditLog.action, 'create')));
		// The group's own `create` row is written by `createGroup` — exclude it by
		// counting only transaction entities.
		const txnRows = await db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.groupId, s.group.id),
					eq(auditLog.action, 'create'),
					eq(auditLog.entityType, 'transaction')
				)
			);
		expect(rows.length).toBeGreaterThanOrEqual(txnRows.length);
		return txnRows.length;
	}

	const body = () => spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] });

	function post(idempotencyKey: string | undefined, payload: unknown, key = s.writeKey.key) {
		return apiCall<Record<string, unknown>>('POST', `/api/v1/groups/${s.group.id}/transactions`, {
			key,
			body: payload,
			idempotencyKey
		});
	}

	// ── IDEMPOTENCY (§16.6) ────────────────────────────────────────────────────

	describe('idempotency', () => {
		it('same key + same body REPLAYS: no duplicate transaction, no duplicate audit row', async () => {
			const payload = body();
			const first = await post('ramen-01', payload);
			expect(first.status).toBe(201);

			const replay = await post('ramen-01', payload);
			expect(replay.status).toBe(201);
			// Byte-for-byte the SAME response (same txn id, same DTO) — it was REPLAYED
			// from the store, not recreated.
			expect(replay.body).toEqual(first.body);

			expect(await txnCount()).toBe(1);
			expect(await createAuditCount()).toBe(1);

			// The store's row is `completed` and carries the stored 201 response.
			const [row] = await db
				.select()
				.from(idempotencyKeyTable)
				.where(
					and(
						eq(idempotencyKeyTable.keyId, s.writeKey.id),
						eq(idempotencyKeyTable.idempotencyKey, 'ramen-01')
					)
				);
			expect(row.status).toBe('completed');
			expect(row.responseStatus).toBe(201);
		});

		it('same key + a DIFFERENT body → 409 key_reused, and nothing is created', async () => {
			expect((await post('ramen-02', body())).status).toBe(201);

			const conflict = await post('ramen-02', {
				...body(),
				title: 'A different ramen'
			});
			expect(conflict.status).toBe(409);
			expect(conflict.body).toEqual({
				error: {
					code: 'conflict',
					message: 'This Idempotency-Key was already used with a different request body.',
					details: { reason: 'key_reused' }
				}
			});
			expect(await txnCount()).toBe(1);
			expect(await createAuditCount()).toBe(1);
		});

		it('a DIFFERENT Idempotency-Key with the same body DOES create a second transaction', async () => {
			// Proves the dedup is the header (the §16.6 sole guard) — not fuzzy matching
			// on the body, which would silently swallow a legitimate second ramen.
			expect((await post('ramen-03', body())).status).toBe(201);
			expect((await post('ramen-04', body())).status).toBe(201);
			expect(await txnCount()).toBe(2);
			expect(await createAuditCount()).toBe(2);
		});

		it('the store is scoped to the CALLING key: another key reusing the value is not a replay', async () => {
			const otherKey = await mintApiKey(s.user.id, 'write', 'second writer');
			expect((await post('shared-value', body())).status).toBe(201);

			const second = await post('shared-value', body(), otherKey.key);
			expect(second.status).toBe(201);
			expect(second.body.id).not.toBe(undefined);
			// A genuinely new transaction — one key's namespace cannot collide with another's.
			expect(await txnCount()).toBe(2);
		});

		it('NO header → at-least-once (a retry does create a duplicate)', async () => {
			expect((await post(undefined, body())).status).toBe(201);
			expect((await post(undefined, body())).status).toBe(201);
			expect(await txnCount()).toBe(2);
		});

		it('two CONCURRENT identical retries create AT MOST ONE transaction', async () => {
			const payload = body();
			const [a, b] = await Promise.all([post('race-01', payload), post('race-01', payload)]);

			const statuses = [a.status, b.status].sort();
			// The winner creates (201). The loser either replays the stored 201 or — if the
			// winner is still in flight — gets the 409 `in_progress`. Never a second create.
			expect(statuses[0]).toBe(201);
			expect([201, 409]).toContain(statuses[1]);
			if (statuses[1] === 409) {
				const loser = a.status === 409 ? a : b;
				expect(loser.body).toMatchObject({
					error: { code: 'conflict', details: { reason: 'in_progress' } }
				});
			}

			expect(await txnCount()).toBe(1);
			expect(await createAuditCount()).toBe(1);
		});

		it('settle-up is idempotent too — a retry does not record the transfer twice', async () => {
			await createTransaction({
				userId: s.user.id,
				groupId: s.group.id,
				input: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] }),
				settlementCurrency: SETTLEMENT_CURRENCY
			});

			const settle = { from: s.bob, to: s.alice, amount: 4500 };
			const first = await apiCall<{ id: string }>(
				'POST',
				`/api/v1/groups/${s.group.id}/settle-up`,
				{ key: s.writeKey.key, body: settle, idempotencyKey: 'settle-01' }
			);
			const replay = await apiCall<{ id: string }>(
				'POST',
				`/api/v1/groups/${s.group.id}/settle-up`,
				{ key: s.writeKey.key, body: settle, idempotencyKey: 'settle-01' }
			);

			expect(first.status).toBe(201);
			expect(replay.status).toBe(201);
			expect(replay.body.id).toBe(first.body.id);
			// The spend + exactly ONE transfer.
			expect(await txnCount()).toBe(2);

			// Balances are still square — a double-recorded settle-up would overshoot.
			const balances = await apiCall<{ balance: { amount: number } }[]>(
				'GET',
				`/api/v1/groups/${s.group.id}/balances`,
				{ key: s.readKey.key }
			);
			expect(balances.body.map((b) => b.balance.amount)).toEqual([0, 0]);
		});
	});

	// ── RATE LIMITS (§16.7) ────────────────────────────────────────────────────

	describe('rate limits', () => {
		/** The stored counter for one (key, class) pair. */
		async function counter(keyId: string, action: 'read' | 'write'): Promise<number | null> {
			const rows = await db
				.select({ count: apiKeyClassRateLimit.count })
				.from(apiKeyClassRateLimit)
				.where(eq(apiKeyClassRateLimit.key, rateLimitKey(keyId, action)));
			return rows[0]?.count ?? null;
		}

		it('the READ window (100/60s) allows the 100th request and limits the 101st', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'read burst');
			const max = RATE_LIMITS.read.max;
			expect(max).toBe(100);

			for (let i = 1; i <= max; i++) {
				const res = await apiCall('GET', '/api/v1/currencies', { key: key.key });
				expect(res.status, `request ${i} of ${max} must be allowed`).toBe(200);
			}

			const limited = await apiCall<{
				error: { code: string; details: Record<string, number | string> };
			}>('GET', '/api/v1/currencies', { key: key.key });

			expect(limited.status).toBe(429);
			expect(limited.body.error.code).toBe('rate_limited');
			expect(limited.body.error.details).toEqual({
				scope: 'read',
				limit: 100,
				windowSeconds: 60,
				retryAfterSeconds: expect.any(Number)
			});
			// The standard header, so a client can back off without parsing the body.
			const retryAfter = limited.headers.get('Retry-After');
			expect(retryAfter).toBe(String(limited.body.error.details.retryAfterSeconds));
			expect(Number(retryAfter)).toBeGreaterThan(0);
			expect(Number(retryAfter)).toBeLessThanOrEqual(60);
		});

		it('the WRITE window (20/60s) allows the 20th request and limits the 21st', async () => {
			const key = await mintApiKey(s.user.id, 'write', 'write burst');
			const txnId = await createTransaction({
				userId: s.user.id,
				groupId: s.group.id,
				input: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob] }),
				settlementCurrency: SETTLEMENT_CURRENCY
			});
			const max = RATE_LIMITS.write.max;
			expect(max).toBe(20);

			// DELETE is idempotent (a no-op after the first), so 20 of them exercise the
			// WRITE counter without piling up state.
			for (let i = 1; i <= max; i++) {
				const res = await apiCall('DELETE', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, {
					key: key.key
				});
				expect(res.status, `write ${i} of ${max} must be allowed`).toBe(200);
			}

			const limited = await apiCall<{
				error: { code: string; details: Record<string, number | string> };
			}>('DELETE', `/api/v1/groups/${s.group.id}/transactions/${txnId}`, { key: key.key });

			expect(limited.status).toBe(429);
			expect(limited.body.error.details).toEqual({
				scope: 'write',
				limit: 20,
				windowSeconds: 60,
				retryAfterSeconds: expect.any(Number)
			});
			expect(limited.headers.get('Retry-After')).toBe(
				String(limited.body.error.details.retryAfterSeconds)
			);

			// The counters are INDEPENDENT: the read budget is untouched by the write burst.
			const read = await apiCall('GET', '/api/v1/currencies', { key: key.key });
			expect(read.status).toBe(200);
			expect(await counter(key.id, 'read')).toBe(1);
		});

		it('a read endpoint consumes the READ counter; a write endpoint the WRITE one', async () => {
			const key = await mintApiKey(s.user.id, 'write', 'classifier');

			await apiCall('GET', `/api/v1/groups/${s.group.id}`, { key: key.key });
			expect(await counter(key.id, 'read')).toBe(1);
			expect(await counter(key.id, 'write')).toBeNull();

			// The class is the ENDPOINT's (§16.2), not the key's own scope — this key is a
			// `write` key, yet its GET above consumed the READ counter.
			await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions`, {
				key: key.key,
				body: body()
			});
			expect(await counter(key.id, 'write')).toBe(1);
			expect(await counter(key.id, 'read')).toBe(1);
		});

		it('a read key denied by the 403 scope guard never consumes the write budget', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'scope first');

			const denied = await apiCall('POST', `/api/v1/groups/${s.group.id}/transactions`, {
				key: key.key,
				body: body()
			});
			expect(denied.status).toBe(403);
			// The scope guard runs BEFORE the limiter (§16.7), so no write counter row exists.
			expect(await counter(key.id, 'write')).toBeNull();
		});

		it('an UNAUTHENTICATED request never consumes any counter (the 401 gate comes first)', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'unauthed');
			const res = await apiCall('GET', '/api/v1/currencies', { key: 'pwm_test_bogus' });
			expect(res.status).toBe(401);
			expect(await counter(key.id, 'read')).toBeNull();
		});
	});
});
