// The `/docs/api` quickstart, as DATA (PLAN §16.9).
//
// One copy-pasteable read + write worked example: mint a key in Settings → `curl`
// the groups list (read) → `curl` a transaction create (write, with
// `Authorization: Bearer`, an `Idempotency-Key`, and the exact money JSON) → the
// success envelope and one error envelope.
//
// It lives here as a MODULE rather than as markup inside `+page.svelte` for one
// reason: the request bodies are then SHAPE-CHECKED against the OpenAPI component
// schemas by the contract test (`openapi.contract.test.ts`, PLAN §16.10). A
// quickstart that drifts from the spec fails the build instead of quietly lying to
// the next agent that copies it.
//
// PER-ENDPOINT SHAPES ARE SPEC-ONLY (§16.9): this file deliberately documents the
// ONE worked example and nothing more — every other endpoint's request/response
// shape lives in `openapi.yaml` alone, so there is no second place for it to rot.

/** The relative base path every v1 endpoint hangs off (`servers` in the spec). */
export const API_BASE_PATH = '/api/v1';

/** Where the raw spec is fetchable from (served verbatim as a static asset). */
export const OPENAPI_YAML_PATH = '/api/v1/openapi.yaml';
/** The same spec as JSON, generated from the YAML (`pnpm openapi:json`). */
export const OPENAPI_JSON_PATH = '/api/v1/openapi.json';

/**
 * Last-resort origin for the quickstart, used ONLY when no real one is available
 * (i.e. a caller that has neither a request nor `BETTER_AUTH_URL` — in practice just
 * unit tests). The rendered docs never show this: `/docs/api` resolves the origin
 * from the deployment it is actually being served by (see `resolveDocsOrigin`), so a
 * reader can copy a `curl` that works against THIS host without editing it.
 *
 * The API itself stays host-agnostic — which is why the spec's `servers` entry
 * remains the relative {@link API_BASE_PATH}.
 */
export const FALLBACK_ORIGIN = 'http://localhost:5173';

/**
 * The origin the quickstart's `curl` examples should address.
 *
 * Precedence, and why:
 *  1. **`BETTER_AUTH_URL`** — the app's own canonical origin (`.env`, already the
 *     WebAuthn origin). It is the right answer whenever it is set, because behind a
 *     proxy or on a preview URL the request host may not be the origin operators
 *     actually call.
 *  2. **The live request origin** — zero-config and always correct for whatever host
 *     the reader is reading the docs on.
 *  3. {@link FALLBACK_ORIGIN} — only if neither is available.
 *
 * A trailing slash is trimmed so `${origin}${API_BASE_PATH}` never doubles up.
 */
export function resolveDocsOrigin(options: {
	requestOrigin?: string;
	configuredOrigin?: string;
}): string {
	const candidate = options.configuredOrigin?.trim() || options.requestOrigin?.trim();
	return (candidate || FALLBACK_ORIGIN).replace(/\/+$/, '');
}

/** The shell variable the examples read the key from — never a key inline. */
export const KEY_ENV_VAR = 'PWM_API_KEY';

/**
 * The create-transaction request body used by the quickstart's WRITE step. A
 * §7.6-trivial same-currency case: `exchangeRate: "1"` and
 * `amountTotalSettlement == amountTotal`, so the caller-supplied settlement total is
 * obviously correct. Validated against the spec's `TransactionInput` schema by the
 * contract test.
 *
 * ฿900.00 = `90000` THB minor units, paid by Ada, split equally between Ada and
 * Grace. Money is ALWAYS integer minor units — never `900.0`.
 */
export const QUICKSTART_CREATE_BODY = {
	type: 'spending',
	title: 'Ramen',
	date: '2026-05-04',
	categoryId: 'spending-food-drink',
	amountTotal: 90000,
	currency: 'THB',
	exchangeRate: '1',
	amountTotalSettlement: 90000,
	splitMode: 'equal',
	payers: [{ memberId: 'mem_ada', amountPaid: 90000 }],
	beneficiaries: [{ memberId: 'mem_ada' }, { memberId: 'mem_grace' }],
	items: [],
	charges: []
} as const;

/**
 * The 201 body the write step returns — the same `TransactionDetail` every read
 * serves. Shape-checked against the spec's `TransactionDetail` schema, so the
 * "success envelope" the quickstart shows can never drift from the real one. Note
 * the resolved `shares` (settlement currency) — that is what balances are built from.
 */
export const QUICKSTART_CREATE_RESPONSE = {
	id: 'txn_ramen',
	groupId: 'grp_tokyo',
	type: 'spending',
	title: 'Ramen',
	categoryId: 'spending-food-drink',
	categoryName: 'Food & drink',
	categoryIcon: 'utensils',
	amount: { amount: 90000, currency: 'THB' },
	settlementAmount: { amount: 90000, currency: 'THB' },
	isForeign: false,
	splitMode: 'equal',
	createdAt: '2026-05-04T12:00:00.000Z',
	deletedAt: null,
	payers: [{ memberId: 'mem_ada', amountPaid: { amount: 90000, currency: 'THB' } }],
	shares: [
		{ memberId: 'mem_ada', amountOwed: { amount: 45000, currency: 'THB' } },
		{ memberId: 'mem_grace', amountOwed: { amount: 45000, currency: 'THB' } }
	],
	items: [],
	charges: []
} as const;

/**
 * The 200 body the read step returns (a `Group[]`). Shape-checked against the spec's
 * `Group` schema.
 */
export const QUICKSTART_GROUPS_RESPONSE = [
	{
		id: 'grp_tokyo',
		name: 'Tokyo trip',
		settlementCurrency: 'THB',
		createdBy: 'usr_ada',
		createdAt: '2026-05-01T09:12:03.000Z'
	}
] as const;

/**
 * The ONE error envelope the quickstart shows: a 422 whose `details.fieldErrors`
 * names the field that failed — here the §7.6 settlement-total rule, the mistake an
 * agent is most likely to make. Shape-checked against the spec's `Error` schema.
 */
export const QUICKSTART_ERROR_RESPONSE = {
	error: {
		code: 'validation_error',
		message: 'The request failed validation.',
		details: {
			formErrors: [],
			fieldErrors: {
				amountTotalSettlement: ['The settlement total does not match the converted amount']
			}
		}
	}
} as const;

/** Pretty-print a body exactly as it appears in the quickstart's `curl` / output blocks. */
export function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** The READ step's `curl`, against the origin the docs are being served from. */
export function quickstartReadCommand(origin: string): string {
	return [
		`curl -sS ${origin}${API_BASE_PATH}/groups \\`,
		`  -H "Authorization: Bearer $${KEY_ENV_VAR}"`
	].join('\n');
}

/**
 * The WRITE step's `curl` — the header trio an agent must get right
 * (`Authorization: Bearer`, `Content-Type: application/json`, `Idempotency-Key`) plus
 * the exact money JSON. The `Idempotency-Key` is a value YOU choose and REUSE on a
 * retry: same key + same body replays the original 201 instead of recording a second
 * ramen.
 */
export function quickstartWriteCommand(origin: string): string {
	return [
		`curl -sS -X POST ${origin}${API_BASE_PATH}/groups/grp_tokyo/transactions \\`,
		`  -H "Authorization: Bearer $${KEY_ENV_VAR}" \\`,
		`  -H "Content-Type: application/json" \\`,
		`  -H "Idempotency-Key: ramen-2026-05-04-01" \\`,
		`  -d '${formatJson(QUICKSTART_CREATE_BODY)}'`
	].join('\n');
}
