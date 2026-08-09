// Unit tests for the `v1` group-currency mapper (issue #68; PLAN §16.4, §7.5.2;
// ADR-0014 decision 8).
//
// One rule carries this DTO: `code` is the DISPLAY code, never the opaque row key.
// For a seeded row the two are equal, so a test that only checked `THB` would pass
// with the mapper reading the wrong field — every case below therefore includes a
// CUSTOM row, where the two differ.

import { describe, it, expect } from 'vitest';
import { toGroupCurrencyDto } from './group-currency';
import type { GroupCurrency } from '$lib/server/currencies';

/** A seeded row as `listCurrenciesForGroup` returns it (`code == display_code`). */
const seeded: GroupCurrency = {
	code: 'THB',
	displayCode: 'THB',
	name: 'Thai Baht',
	exponent: 2,
	symbol: '฿',
	groupId: null,
	createdBy: null,
	createdAt: null,
	isCustom: false
};

/** A group-defined row: the opaque key and the display code DIVERGE. */
const custom: GroupCurrency = {
	code: 'cur_9f2e5a10-0000-4000-8000-000000000001',
	displayCode: 'BEER',
	name: 'Bottle of beer',
	exponent: 0,
	symbol: '🍺',
	groupId: 'grp_1',
	createdBy: 'usr_mallory',
	createdAt: new Date('2026-08-01T00:00:00.000Z'),
	isCustom: true
};

describe('toGroupCurrencyDto', () => {
	it('maps a seeded row to the { code, exponent, symbol } triple', () => {
		expect(toGroupCurrencyDto(seeded)).toEqual({ code: 'THB', exponent: 2, symbol: '฿' });
	});

	it('emits the DISPLAY code for a custom row, never the opaque key', () => {
		const dto = toGroupCurrencyDto(custom);
		expect(dto).toEqual({ code: 'BEER', exponent: 0, symbol: '🍺' });
		expect(JSON.stringify(dto)).not.toContain('cur_');
	});

	it('keeps a 0-exponent custom currency at its own scale', () => {
		// `3 BEER` is 3 minor units, not 300 — the exponent is the only thing a client
		// has to interpret the integer with, so it must come off the row.
		expect(toGroupCurrencyDto(custom).exponent).toBe(0);
	});

	it('drops the internal fields: name, groupId, createdBy, createdAt, isCustom', () => {
		// `name` is a UI label, not part of a formatting reference contract (the global
		// `GET /currencies` drops it for the same reason); the rest are storage detail.
		// `isCustom` in particular would re-expose the seeded/custom split the display
		// code deliberately flattens.
		for (const row of [seeded, custom]) {
			expect(Object.keys(toGroupCurrencyDto(row)).sort()).toEqual(['code', 'exponent', 'symbol']);
		}
	});
});
