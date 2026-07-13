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
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
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
	QUICKSTART_READ_COMMAND,
	QUICKSTART_WRITE_COMMAND
} from './api-quickstart';
import { loadOpenApiYaml } from './openapi';

// ── Compile the spec's component schemas ─────────────────────────────────────
// `strict: false` + `validateFormats: false`: an OpenAPI document carries annotation
// keywords Ajv doesn't know (`example`, `summary`, `discriminator`, `format: date-time`).
// We are validating STRUCTURE (required fields, types, enums, `additionalProperties:
// false`), which is exactly the part of the contract a client depends on.
const spec = loadOpenApiYaml();
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(spec, 'openapi');

/** Get a compiled validator for one `#/components/schemas/<name>` subschema. */
function validator(name: string): ValidateFunction {
	const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
	if (!validate) throw new Error(`No such component schema: ${name}`);
	return validate;
}

/**
 * Assert `value` matches the named component schema, reporting Ajv's field-level
 * errors on failure (so a break points straight at the offending property).
 */
function expectValid(name: string, value: unknown): void {
	const validate = validator(name);
	const ok = validate(value);
	expect(ok, `${name} mismatch: ${ajv.errorsText(validate.errors, { separator: '\n  ' })}`).toBe(
		true
	);
}

/** Assert `value` does NOT match — used to prove the schemas actually bite. */
function expectInvalid(name: string, value: unknown): void {
	expect(validator(name)(value)).toBe(false);
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
		expect(QUICKSTART_READ_COMMAND).toContain('Authorization: Bearer');
		expect(QUICKSTART_WRITE_COMMAND).toContain('Authorization: Bearer');
		expect(QUICKSTART_WRITE_COMMAND).toContain('Idempotency-Key:');
		expect(QUICKSTART_WRITE_COMMAND).toContain('Content-Type: application/json');
		// The read step is a GET; the write step posts to the real create path.
		expect(QUICKSTART_WRITE_COMMAND).toContain('/api/v1/groups/grp_tokyo/transactions');
		expect(QUICKSTART_READ_COMMAND).toContain('/api/v1/groups');
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
