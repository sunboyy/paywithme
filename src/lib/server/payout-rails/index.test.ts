import { describe, it, expect } from 'vitest';
import {
	PAYOUT_RAILS,
	RAILS,
	RAIL_IDS,
	UnknownRailError,
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
