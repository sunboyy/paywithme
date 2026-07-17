// CONTRACT TEST — the anti-rot mechanism for the OpenAPI spec (PLAN §16.9, §16.10).
//
// The spec is hand-written, so nothing structurally forces it to keep telling the
// truth. This test does: it validates, against the spec's own component schemas
// (compiled with Ajv as JSON Schema 2020-12, which OpenAPI 3.1 schemas ARE):
//
//   1. REAL response payloads — produced by the actual `src/lib/server/api/v1`
//      mappers the routes use, from internal read-model fixtures. If a mapper starts
//      emitting a field the spec doesn't declare (or drops one it does), this fails.
//      Every component schema is `additionalProperties: false`, so an UNDOCUMENTED
//      field is a failure, not a shrug.
//   2. The `/docs/api` QUICKSTART's curl request bodies and example responses — so
//      the one worked example a reader copy-pastes is provably a valid request and a
//      truthful response.
//   3. The spec's own inline `example` / `examples` values, which is what an agent
//      actually reads.
//
// Together with `openapi.test.ts` (yaml/json sync + operation coverage) this is what
// keeps the published contract honest without generating it.

import { describe, it, expect } from 'vitest';
import type { Group } from '$lib/server/groups';
import type { MemberListItem } from '$lib/server/members';
import type { MemberBalance } from '$lib/transactions/balances';
import type { TransactionDetail, TransactionListItem } from '$lib/server/transactions';
import {
	toGroupDto,
	toMemberDto,
	toBalanceDto,
	toTransactionListItemDto,
	toTransactionDetailDto
} from '$lib/server/api/v1';
import { CURRENCIES } from '$lib/money';
import { apiErrorEnvelope } from '$lib/server/api/errors';
import {
	QUICKSTART_CREATE_BODY,
	QUICKSTART_CREATE_RESPONSE,
	QUICKSTART_GROUPS_RESPONSE,
	QUICKSTART_ERROR_RESPONSE,
	quickstartReadCommand,
	quickstartWriteCommand,
	resolveDocsOrigin,
	FALLBACK_ORIGIN
} from './api-quickstart';
import { createComponentSchemaChecker, loadOpenApiYaml } from './openapi';

/** A stand-in for "whatever origin the docs are served from" (see `resolveDocsOrigin`). */
const TEST_ORIGIN = 'https://pay.example.org';

// The spec's component schemas, compiled ONCE. The SAME checker backs the LIVE
// contract test (`tests/integration/api-contract.test.ts`), so "valid" means exactly
// the same thing for a mapper fixture here and for a real wire response there.
const spec = loadOpenApiYaml();
const { check } = createComponentSchemaChecker(spec);

/**
 * Assert `value` matches the named component schema, reporting Ajv's field-level
 * errors on failure (so a break points straight at the offending property).
 */
function expectValid(name: string, value: unknown): void {
	const result = check(name, value);
	expect(result.ok, `${name} mismatch: ${result.errors}`).toBe(true);
}

/** Assert `value` does NOT match — used to prove the schemas actually bite. */
function expectInvalid(name: string, value: unknown): void {
	expect(check(name, value).ok).toBe(false);
}

// ── Internal read-model fixtures (the shapes the real services return) ────────

const group: Group = {
	id: 'grp_tokyo',
	name: 'Tokyo trip',
	settlementCurrency: 'THB',
	createdBy: 'usr_ada',
	createdAt: new Date('2026-05-01T09:12:03.000Z'),
	deletedAt: null
};

const members: MemberListItem[] = [
	{
		id: 'mem_ada',
		displayName: 'Ada',
		userId: 'usr_ada',
		deactivatedAt: null,
		isLinked: true
	},
	{
		id: 'mem_grace',
		displayName: 'Grace',
		userId: null,
		deactivatedAt: '2026-06-01T00:00:00.000Z',
		isLinked: false
	}
];

const balances: MemberBalance[] = [
	{ memberId: 'mem_ada', balance: 45000 },
	// Negative balances are real (a debtor) — the Money schema must accept them.
	{ memberId: 'mem_grace', balance: -45000 }
];

const listItem: TransactionListItem = {
	id: 'txn_ramen',
	type: 'spending',
	title: 'Ramen',
	createdBy: 'usr_ada',
	categoryId: 'spending-food-drink',
	categoryName: 'Food & drink',
	categoryIcon: 'utensils',
	amountTotal: 3600,
	currency: 'JPY',
	amountTotalSettlement: 87840,
	settlementCurrency: 'THB',
	isForeign: true,
	createdAt: '2026-05-04T12:00:00.000Z',
	occurredAt: '2026-05-04T18:31:07.412Z'
};

/** An ITEMIZED, foreign-currency, soft-deleted detail — the widest shape we serve. */
const detail: TransactionDetail = {
	id: 'txn_ramen',
	groupId: 'grp_tokyo',
	type: 'spending',
	title: 'Ramen in Tokyo',
	categoryId: 'spending-food-drink',
	categoryName: 'Food & drink',
	categoryIcon: 'utensils',
	// Internal-only authorship (who wrote the title): the MCP view attributes the
	// untrusted envelope with it (ADR-0003). It is deliberately NOT on the `/api/v1`
	// wire — the assertions below prove the DTO does not carry it.
	createdBy: 'usr_author',
	amountTotal: 3600,
	currency: 'JPY',
	amountTotalSettlement: 87840,
	settlementCurrency: 'THB',
	isForeign: true,
	splitMode: 'itemized',
	createdAt: '2026-05-04T12:00:00.000Z',
	deletedAt: '2026-05-06T08:00:00.000Z',
	payers: [{ memberId: 'mem_ada', amountPaid: 3600 }],
	shares: [
		{ memberId: 'mem_ada', amountOwed: 43920 },
		{ memberId: 'mem_grace', amountOwed: 43920 }
	],
	items: [
		{
			label: 'Tonkotsu',
			amount: 3000,
			splitMode: 'equal',
			shares: [
				{ memberId: 'mem_ada', amountOwed: 36600 },
				{ memberId: 'mem_grace', amountOwed: 36600 }
			]
		}
	],
	charges: [
		{ kind: 'vat', mode: 'percent', value: 700, base: 'items_subtotal', sortOrder: 0 },
		{ kind: 'tip', mode: 'absolute', value: 100, base: 'running_total', sortOrder: 1 }
	],
	// The internal edit-form seed the mapper must drop — present here precisely so a
	// mapper that ever leaked it would fail the `additionalProperties: false` schema.
	input: { sentinel: 'must-not-leak' } as unknown as TransactionDetail['input']
};

// ── 1. Real DTO output validates against the spec ────────────────────────────

describe('live DTO output matches the spec (PLAN §16.10)', () => {
	it('Group', () => {
		expectValid('Group', toGroupDto(group));
	});

	it('Member — both a linked and an unlinked/deactivated slot', () => {
		for (const member of members) expectValid('Member', toMemberDto(member));
	});

	it('Balance — including a NEGATIVE (debtor) balance', () => {
		for (const balance of balances) expectValid('Balance', toBalanceDto(balance, 'THB'));
	});

	it('TransactionListItem', () => {
		expectValid('TransactionListItem', toTransactionListItemDto(listItem));
	});

	it('TransactionPage — the one paginated envelope, last page and not', () => {
		const data = [toTransactionListItemDto(listItem)];
		expectValid('TransactionPage', { data, nextCursor: 'b3BhcXVl' });
		expectValid('TransactionPage', { data: [], nextCursor: null });
	});

	it('TransactionDetail — itemized, foreign-currency, soft-deleted (the widest shape)', () => {
		const dto = toTransactionDetailDto(detail);
		expectValid('TransactionDetail', dto);
		// The whole point of the owned DTO: the internal `input` seed never reaches the
		// wire. `additionalProperties: false` above already enforces it; assert it plainly.
		expect(dto).not.toHaveProperty('input');
	});

	it('Currency — every currency in the real §7.5.1 table', () => {
		for (const c of CURRENCIES) {
			expectValid('Currency', { code: c.code, exponent: c.exponent, symbol: c.symbol });
		}
	});

	it('Error — every envelope the real `errors.ts` builder can emit', () => {
		expectValid('Error', apiErrorEnvelope('not_found'));
		expectValid('Error', apiErrorEnvelope('forbidden_scope'));
		expectValid(
			'Error',
			apiErrorEnvelope('rate_limited', 'Rate limit exceeded.', {
				scope: 'write',
				limit: 20,
				windowSeconds: 60,
				retryAfterSeconds: 37
			})
		);
		expectValid('Error', apiErrorEnvelope('conflict', 'Already used.', { reason: 'key_reused' }));
		expectValid(
			'Error',
			apiErrorEnvelope('validation_error', 'The request failed validation.', {
				formErrors: [],
				fieldErrors: { amountTotalSettlement: ['does not match'] }
			})
		);
	});

	it('rejects a payload that drifts from the schema (the check actually bites)', () => {
		// A float amount — the exact bug the integer-minor-units rule exists to prevent.
		expectInvalid('Money', { amount: 900.5, currency: 'THB' });
		// A money object carrying the `exponent`/`display` §16.4 explicitly keeps OFF the wire.
		expectInvalid('Money', { amount: 90000, currency: 'THB', exponent: 2 });
		// An undocumented extra field on a response DTO.
		expectInvalid('Group', { ...toGroupDto(group), deletedAt: null });
		// An error code outside the §16.5 enum.
		expectInvalid('Error', { error: { code: 'teapot', message: 'nope' } });
	});
});

// ── 2. The /docs/api quickstart is shape-checked (§16.9) ─────────────────────

describe('the /docs/api quickstart matches the spec', () => {
	it('its create body is a valid TransactionInput', () => {
		expectValid('TransactionInput', QUICKSTART_CREATE_BODY);
	});

	it('its create body honours the §7.6 settlement rule it claims to (rate 1, same currency)', () => {
		// The quickstart's whole pedagogical point: same-currency is trivial. If someone
		// edits the numbers, this catches a body that would 422 in reality.
		expect(QUICKSTART_CREATE_BODY.exchangeRate).toBe('1');
		expect(QUICKSTART_CREATE_BODY.amountTotalSettlement).toBe(QUICKSTART_CREATE_BODY.amountTotal);
		const paid = QUICKSTART_CREATE_BODY.payers.reduce((sum, p) => sum + p.amountPaid, 0);
		expect(paid).toBe(QUICKSTART_CREATE_BODY.amountTotal);
	});

	it('its example responses are valid Group[] / TransactionDetail / Error payloads', () => {
		for (const g of QUICKSTART_GROUPS_RESPONSE) expectValid('Group', g);
		expectValid('TransactionDetail', QUICKSTART_CREATE_RESPONSE);
		expectValid('Error', QUICKSTART_ERROR_RESPONSE);
	});

	it('shows the headers an agent must get right', () => {
		const read = quickstartReadCommand(TEST_ORIGIN);
		const write = quickstartWriteCommand(TEST_ORIGIN);

		expect(read).toContain('Authorization: Bearer');
		expect(write).toContain('Authorization: Bearer');
		expect(write).toContain('Idempotency-Key:');
		expect(write).toContain('Content-Type: application/json');
		// The read step is a GET; the write step posts to the real create path.
		expect(write).toContain('/api/v1/groups/grp_tokyo/transactions');
		expect(read).toContain('/api/v1/groups');
	});

	it('addresses the CALLER’S origin — no example host is baked into the commands', () => {
		// The whole point of parameterizing the origin: whatever host the docs are
		// served from is the host the copied `curl` hits. A literal origin creeping back
		// into the builders (or a stray placeholder domain) fails here.
		const read = quickstartReadCommand(TEST_ORIGIN);
		const write = quickstartWriteCommand(TEST_ORIGIN);

		expect(read).toContain(`${TEST_ORIGIN}/api/v1/groups`);
		expect(write).toContain(`${TEST_ORIGIN}/api/v1/groups/grp_tokyo/transactions`);
		for (const command of [read, write]) {
			// Exactly ONE origin per command, and it's the one we passed in.
			expect(command.match(/https?:\/\/[^\s/]+/g)).toEqual([TEST_ORIGIN]);
		}
	});

	describe('resolveDocsOrigin', () => {
		it('prefers the configured canonical origin over the request host', () => {
			// Behind a proxy / on a preview URL the request host is not what operators
			// call, so `BETTER_AUTH_URL` wins whenever it is set.
			expect(
				resolveDocsOrigin({
					requestOrigin: 'https://preview-xyz.vercel.app',
					configuredOrigin: 'https://pay.example.org'
				})
			).toBe('https://pay.example.org');
		});

		it('falls back to the live request origin when nothing is configured', () => {
			// Zero-config: the docs still show a `curl` that works against THIS host.
			expect(
				resolveDocsOrigin({ requestOrigin: 'https://pay.example.org', configuredOrigin: undefined })
			).toBe('https://pay.example.org');
			// A blank/whitespace env var is treated as unset, not as an empty origin.
			expect(
				resolveDocsOrigin({ requestOrigin: 'https://pay.example.org', configuredOrigin: '  ' })
			).toBe('https://pay.example.org');
		});

		it('trims a trailing slash so the base path never doubles up', () => {
			expect(resolveDocsOrigin({ configuredOrigin: 'https://pay.example.org/' })).toBe(
				'https://pay.example.org'
			);
			expect(
				quickstartReadCommand(resolveDocsOrigin({ configuredOrigin: 'https://x.test/' }))
			).toContain('https://x.test/api/v1/groups');
		});

		it('falls back to localhost only when there is neither a request nor config', () => {
			expect(resolveDocsOrigin({})).toBe(FALLBACK_ORIGIN);
		});
	});
});

// ── 3. The spec's own examples validate against its own schemas ──────────────

describe("the spec's inline examples match its schemas", () => {
	/** `[schemaName, example]` for every request-body example the spec publishes. */
	function requestBodyExamples(): [string, unknown][] {
		const out: [string, unknown][] = [];
		const paths = spec.paths as Record<string, Record<string, unknown>>;
		for (const item of Object.values(paths)) {
			for (const op of Object.values(item)) {
				const body = (op as Record<string, unknown>)?.requestBody as
					| Record<string, Record<string, Record<string, Record<string, unknown>>>>
					| undefined;
				const media = body?.content?.['application/json'];
				if (!media) continue;

				const ref = (media.schema as unknown as { $ref?: string })?.$ref;
				if (!ref) continue;
				const name = ref.split('/').pop() as string;

				if (media.example !== undefined) out.push([name, media.example]);
				for (const example of Object.values(
					(media.examples ?? {}) as Record<string, { value: unknown }>
				)) {
					out.push([name, example.value]);
				}
			}
		}
		return out;
	}

	it('every request-body example is a valid instance of its schema', () => {
		const examples = requestBodyExamples();
		// Guard the guard: the walker must actually find the create + settle-up examples.
		expect(examples.length).toBeGreaterThanOrEqual(3);
		for (const [name, example] of examples) expectValid(name, example);
	});

	it('the TransactionDetail and Money component examples are valid', () => {
		const schemas = (spec.components as Record<string, Record<string, Record<string, unknown[]>>>)
			.schemas;
		for (const example of schemas.Money.examples) expectValid('Money', example);
		for (const example of schemas.TransactionDetail.examples) {
			expectValid('TransactionDetail', example);
		}
		for (const example of schemas.Error.examples) expectValid('Error', example);
	});
});
