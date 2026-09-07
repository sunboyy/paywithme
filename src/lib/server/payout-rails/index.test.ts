import { describe, it, expect } from 'vitest';
import {
	PAYOUT_RAILS,
	RAILS,
	RAIL_IDS,
	UnknownRailError,
	buildRailQr,
	findRail,
	formatRailDetails,
	getRail,
	isRailId,
	parseRailDetails
} from './index';
import { thBankAccountDetailsSchema } from '$lib/schemas/receiving-method';

// Unit spec for the rail registry (issue #83; PLAN §17.2; ADR-0016).
//
// What the registry promises, and is therefore checked here:
//   - one entry per rail, keyed by the id stored in `receiving_method.rail`;
//   - an UNKNOWN RAIL KEY IS REJECTED everywhere — `details` no entry can validate
//     is never stored and never rendered;
//   - each entry validates through its own schema and renders through its own
//     formatter, so nothing outside a rail's own module knows its field shape;
//   - no rail is privileged: the assertions below are written over `RAIL_IDS`
//     rather than naming one rail as the default.

const VALID_DETAILS: Record<string, unknown> = {
	th_bank_account: {
		bank: 'kbank',
		accountNumber: '1234567890',
		accountHolderName: 'Somchai Jaidee'
	},
	th_promptpay: {
		proxyType: 'mobile',
		proxyValue: '0812345678',
		accountHolderName: 'Somchai Jaidee'
	},
	other: { label: 'Wise (EUR)', text: 'IBAN DE89 3704 0044 0532 0130 00' }
};

describe('the registry', () => {
	it('ships exactly the v1 rails', () => {
		expect(RAIL_IDS).toEqual(['th_bank_account', 'th_promptpay', 'other']);
	});

	it('keys every entry by its own id', () => {
		// The map is written with literal keys (so `RailId` is a union, not `string`);
		// this is what stops a key and its entry's `id` drifting apart.
		for (const id of RAIL_IDS) expect(PAYOUT_RAILS[id].id).toBe(id);
	});

	it('gives every entry a label, a schema and a formatter', () => {
		for (const rail of RAILS) {
			expect(rail.label.trim()).not.toBe('');
			expect(typeof rail.detailsSchema.safeParse).toBe('function');
			expect(typeof rail.format).toBe('function');
		}
		expect(RAILS).toHaveLength(RAIL_IDS.length);
	});

	it('has a valid-payload fixture for every shipped rail', () => {
		// Guards the tests below: a new rail added to the registry without a fixture
		// here would otherwise silently skip every check.
		expect(Object.keys(VALID_DETAILS).sort()).toEqual([...RAIL_IDS].sort());
	});
});

describe('isRailId / findRail / getRail', () => {
	it('recognises every shipped rail', () => {
		for (const id of RAIL_IDS) {
			expect(isRailId(id)).toBe(true);
			expect(findRail(id)).toBe(PAYOUT_RAILS[id]);
			expect(getRail(id)).toBe(PAYOUT_RAILS[id]);
		}
	});

	it('rejects an unknown rail key', () => {
		for (const unknown of ['sepa', 'th_bank', 'TH_BANK_ACCOUNT', '', 'toString', '__proto__']) {
			expect(isRailId(unknown), unknown).toBe(false);
			expect(findRail(unknown), unknown).toBeUndefined();
			expect(() => getRail(unknown)).toThrow(UnknownRailError);
		}
	});

	it('rejects non-string rail values', () => {
		for (const value of [null, undefined, 42, {}, ['th_promptpay']]) {
			expect(isRailId(value)).toBe(false);
		}
	});
});

describe('parseRailDetails', () => {
	it('accepts each rail its own valid payload', () => {
		for (const id of RAIL_IDS) {
			const result = parseRailDetails(id, VALID_DETAILS[id]);
			expect(result.success, id).toBe(true);
			if (!result.success) continue;
			expect(result.rail).toBe(id);
			expect(result.details).toEqual(VALID_DETAILS[id]);
		}
	});

	it('returns the PARSED details, so trimmed values and no stray keys are stored', () => {
		const result = parseRailDetails('th_bank_account', {
			bank: 'kbank',
			accountNumber: '1234567890',
			accountHolderName: '  Somchai Jaidee  ',
			position: 99
		});
		expect(result).toEqual({
			success: true,
			rail: 'th_bank_account',
			details: {
				bank: 'kbank',
				accountNumber: '1234567890',
				accountHolderName: 'Somchai Jaidee'
			}
		});
	});

	it('rejects an unknown rail key WITHOUT looking at the details', () => {
		// The details below are a perfectly valid `th_bank_account` payload: it is the
		// rail that is unknown, and nothing may store details no entry can validate.
		const result = parseRailDetails('sepa', VALID_DETAILS.th_bank_account);
		expect(result).toEqual({ success: false, reason: 'unknown_rail' });
	});

	it('rejects details that belong to a DIFFERENT rail', () => {
		const result = parseRailDetails('th_promptpay', VALID_DETAILS.th_bank_account);
		expect(result.success).toBe(false);
		if (result.success || result.reason !== 'invalid_details') throw new Error('expected issues');
		expect(result.error.issues.length).toBeGreaterThan(0);
	});

	it('reports a rail schema failure as invalid_details, with the schema issues', () => {
		const invalid = { ...(VALID_DETAILS.th_bank_account as object), accountHolderName: '   ' };
		const result = parseRailDetails('th_bank_account', invalid);
		expect(result.success).toBe(false);
		if (result.success || result.reason !== 'invalid_details') throw new Error('expected issues');
		expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('accountHolderName');
		// The registry does not paraphrase: the messages are the rail schema's own.
		expect(result.error.issues[0].message).toBe(
			thBankAccountDetailsSchema.safeParse(invalid).error?.issues[0].message
		);
	});

	it('rejects a non-object payload on every rail', () => {
		for (const id of RAIL_IDS) {
			for (const details of [null, undefined, 'string', 7]) {
				expect(parseRailDetails(id, details).success, `${id} ${String(details)}`).toBe(false);
			}
		}
	});
});

describe('formatRailDetails', () => {
	it('renders each rail through its own formatter', () => {
		expect(formatRailDetails('th_bank_account', VALID_DETAILS.th_bank_account)).toBe(
			'Kasikornbank (KBank) · 1234567890 · Somchai Jaidee'
		);
		expect(formatRailDetails('th_promptpay', VALID_DETAILS.th_promptpay)).toBe(
			'Mobile number · 0812345678 · Somchai Jaidee'
		);
		expect(formatRailDetails('other', VALID_DETAILS.other)).toBe(
			'Wise (EUR) · IBAN DE89 3704 0044 0532 0130 00'
		);
	});

	it('ends the Thai rails with the holder name — the line the payer compares', () => {
		for (const id of ['th_bank_account', 'th_promptpay']) {
			expect(formatRailDetails(id, VALID_DETAILS[id])).toMatch(/Somchai Jaidee$/);
		}
	});

	it('throws rather than half-rendering details the rail rejects', () => {
		expect(() =>
			formatRailDetails('th_bank_account', { bank: 'kbank', accountNumber: '1234567890' })
		).toThrow();
	});

	it('throws for an unknown rail', () => {
		expect(() => formatRailDetails('sepa', VALID_DETAILS.th_bank_account)).toThrow(
			UnknownRailError
		);
	});
});

// ── Field descriptors (issue #85) ────────────────────────────────────────────
// The descriptors are what `/settings/receiving` renders instead of a per-rail
// `if`. They are only worth anything if they stay pinned to the rail's OWN schema,
// so the checks below are all drift guards, written over `RAILS` rather than
// naming a rail.

/** The keys a rail's object schema declares, in declaration order. */
function shapeKeysOf(rail: (typeof RAILS)[number]): string[] {
	return Object.keys((rail.detailsSchema as unknown as { shape: Record<string, unknown> }).shape);
}

describe('rail field descriptors', () => {
	it('describes exactly the keys of the rail’s own schema', () => {
		// A renamed schema key that nobody mirrored here would leave the editor
		// posting a field the schema ignores — saving nothing, silently.
		for (const rail of RAILS) {
			expect(rail.fields.map((field) => field.name).sort(), rail.id).toEqual(
				shapeKeysOf(rail).sort()
			);
		}
	});

	it('gives every field a label and a control, with options only where they belong', () => {
		for (const rail of RAILS) {
			for (const field of rail.fields) {
				const where = `${rail.id}.${field.name}`;
				expect(field.label.trim(), where).not.toBe('');
				expect(['text', 'select', 'textarea'], where).toContain(field.control);
				if (field.control === 'select') {
					expect(field.options?.length, where).toBeGreaterThan(0);
				} else {
					expect(field.options, where).toBeUndefined();
				}
			}
		}
	});

	it('offers only select options the rail’s schema accepts', () => {
		// The picker may not offer a bank (or a proxy type) that the schema would
		// reject on submit — the user would fill the form and be refused for a choice
		// the app itself put in front of them.
		for (const rail of RAILS) {
			const valid = VALID_DETAILS[rail.id] as Record<string, unknown>;
			for (const field of rail.fields) {
				for (const option of field.options ?? []) {
					const result = parseRailDetails(rail.id, { ...valid, [field.name]: option.value });
					expect(result.success, `${rail.id}.${field.name}=${option.value}`).toBe(true);
				}
			}
		}
	});

	it('names one value to copy per rail, and at most one name to check (issue #86)', () => {
		// The payer-facing surfaces branch on these roles and nothing else, so a rail
		// with two copy targets (or two holder names) would make them ambiguous —
		// and a rail with none would leave a payer with nothing to put in their bank.
		for (const rail of RAILS) {
			const roles = rail.fields.map((field) => field.payerRole);

			expect(
				roles.filter((role) => role === 'copy'),
				rail.id
			).toHaveLength(1);
			expect(roles.filter((role) => role === 'name-check').length, rail.id).toBeLessThanOrEqual(1);
		}
	});

	it('marks the holder name as the name to check on every rail that has one', () => {
		// PLAN §17.2: the holder name is required on every rail except `other`, and it
		// is the ONLY defence against a valid-but-wrong account number — so wherever a
		// rail collects one, the payer surfaces must be told which field it is.
		for (const rail of RAILS) {
			const holderNames = rail.fields.filter((field) => /holder name/i.test(field.label));

			for (const field of holderNames) {
				expect(field.payerRole, `${rail.id}.${field.name}`).toBe('name-check');
			}
		}
	});

	it('is plain serializable data, because `load` sends it to the browser', () => {
		for (const rail of RAILS) {
			expect(JSON.parse(JSON.stringify(rail.fields)), rail.id).toEqual(
				rail.fields.map((field) => ({ ...field }))
			);
		}
	});
});

describe('buildRailQr (issue #88; ADR-0017)', () => {
	/** A transfer of ฿1,200.00, in the integer minor units the ledger stores. */
	const THB = { amount: 120000, currency: 'THB' } as const;

	it('answers a payload for a rail that has an encoder, and null for one that has none', () => {
		// Written over the whole registry rather than naming the rail with the code:
		// "which rails can be scanned" is a fact about payment networks, and every
		// caller must cope with either answer WITHOUT asking which rail it is holding.
		const answers = RAIL_IDS.map((id) => buildRailQr(id, VALID_DETAILS[id], THB));

		for (const [index, payload] of answers.entries()) {
			const where = RAIL_IDS[index];
			expect(payload === null || payload.length > 0, where).toBe(true);
			// Every rail's answer is decided by the rail itself, and matches whether it
			// declared an encoder at all.
			expect(payload !== null, where).toBe(PAYOUT_RAILS[where].encodeQr !== undefined);
		}

		// …and today exactly one rail can be scanned. A second one appearing here is
		// fine; it appearing WITHOUT a spike behind it is what this pins.
		expect(answers.filter((payload) => payload !== null)).toHaveLength(1);
	});

	it('gives a bank account and free text no code at all (the #82 result)', () => {
		// Not a gap: the spike established that a bank plus an account number encodes
		// to nothing any Thai banking app reads, and `other` is prose.
		expect(buildRailQr('th_bank_account', VALID_DETAILS.th_bank_account, THB)).toBeNull();
		expect(buildRailQr('other', VALID_DETAILS.other, THB)).toBeNull();
	});

	it('encodes the amount the caller asked for', () => {
		const payload = buildRailQr('th_promptpay', VALID_DETAILS.th_promptpay, THB);

		// Tag 54, seven bytes: the figure the settle row is showing, to the satang.
		expect(payload).toContain('54071200.00');
	});

	it('REFUSES any currency but THB', () => {
		// The payload hard-codes ISO 4217 764. A euro figure inside it is one a
		// banking app reads as baht, and the payer cannot tell from the screen — so
		// the only safe answer is no code (PLAN §17.4; correctness, not polish).
		for (const currency of ['EUR', 'USD', 'JPY', 'thb', '']) {
			expect(
				buildRailQr('th_promptpay', VALID_DETAILS.th_promptpay, { amount: 120000, currency }),
				currency
			).toBeNull();
		}
	});

	it('refuses details its own rail no longer accepts', () => {
		// Same rule as the formatter, different failure: a half-read method must not
		// become a code that sends money somewhere unintended.
		expect(buildRailQr('th_promptpay', { proxyType: 'mobile' }, THB)).toBeNull();
		expect(buildRailQr('th_promptpay', null, THB)).toBeNull();
	});

	it('refuses a rail the registry does not know', () => {
		expect(buildRailQr('br_pix', { anything: true }, THB)).toBeNull();
	});
});
