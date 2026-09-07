import { describe, it, expect } from 'vitest';
import { buildCreateCaptureSchema, CAPTURE_NOTE_MAX_LENGTH } from './capture';
import { UNSUPPORTED_CURRENCY_MESSAGE } from './currency';
import { todayUtc } from './day';

// Unit tests for the shared Capture schemas (issue #49; PLAN §7.7; ADR-0012).
//
// The most important block here is the LAST one: a Capture's shape is the whole
// point of the entity, so "a split-mode / payer / rate field never survives
// parsing" is a spec assertion, not a nicety.

/** The group's currency set: the seeded codes this test needs + one custom row. */
const ALLOWED = [{ code: 'THB' }, { code: 'USD' }, { code: 'cur_beer' }];
const schema = buildCreateCaptureSchema(ALLOWED);

/** The first issue's message on a given field path. */
function messageOn(
	result: { success: boolean; error?: unknown },
	field: string
): string | undefined {
	const error = result.error as { issues: { path: PropertyKey[]; message: string }[] } | undefined;
	return error?.issues.find((i) => i.path[0] === field)?.message;
}

describe('buildCreateCaptureSchema — note', () => {
	it('accepts a note alone: it is the only required content (§7.7)', () => {
		const result = schema.parse({ note: 'dinner at the night market' });

		expect(result.note).toBe('dinner at the night market');
		expect(result.amountMinor).toBeUndefined();
		expect(result.currency).toBeUndefined();
	});

	it('trims the note and rejects one that is empty after trimming', () => {
		expect(schema.parse({ note: '  dinner  ' }).note).toBe('dinner');

		for (const note of ['', '   ', '\t\n']) {
			const result = schema.safeParse({ note });
			expect(result.success, `note ${JSON.stringify(note)} should be rejected`).toBe(false);
			expect(messageOn(result, 'note')).toBe('A note is required');
		}
	});

	it('rejects a note past the transaction TITLE cap it prefills on resolve', () => {
		expect(schema.safeParse({ note: 'x'.repeat(CAPTURE_NOTE_MAX_LENGTH) }).success).toBe(true);

		const result = schema.safeParse({ note: 'x'.repeat(CAPTURE_NOTE_MAX_LENGTH + 1) });
		expect(result.success).toBe(false);
		expect(messageOn(result, 'note')).toBe(
			`Note must be ${CAPTURE_NOTE_MAX_LENGTH} characters or fewer`
		);
	});

	it('rejects a missing note', () => {
		expect(schema.safeParse({ amountMinor: 120000, currency: 'THB' }).success).toBe(false);
	});
});

describe('buildCreateCaptureSchema — amount + currency', () => {
	it('keeps the amount in MINOR UNITS, exactly as submitted', () => {
		const result = schema.parse({ note: 'dinner', amountMinor: 120000, currency: 'THB' });

		// 120000 minor units. Nothing scaled it, nothing converted it, and there is no
		// rate or settlement field to carry a conversion in (§7.7 "Edge cases").
		expect(result.amountMinor).toBe(120000);
		expect(result.currency).toBe('THB');
		expect(result).not.toHaveProperty('exchangeRate');
		expect(result).not.toHaveProperty('amountMinorSettlement');
	});

	it('rejects a float, a zero and a negative amount', () => {
		expect(schema.safeParse({ note: 'x', amountMinor: 12.5, currency: 'THB' }).success).toBe(false);
		expect(
			messageOn(schema.safeParse({ note: 'x', amountMinor: 0, currency: 'THB' }), 'amountMinor')
		).toBe('Amount must be more than zero');
		expect(schema.safeParse({ note: 'x', amountMinor: -100, currency: 'THB' }).success).toBe(false);
		expect(
			schema.safeParse({ note: 'x', amountMinor: Number.MAX_SAFE_INTEGER + 10, currency: 'THB' })
				.success
		).toBe(false);
	});

	it('accepts a group CUSTOM currency and rejects one from outside the set', () => {
		expect(schema.parse({ note: 'x', amountMinor: 3, currency: 'cur_beer' }).currency).toBe(
			'cur_beer'
		);

		for (const currency of ['XXX', 'thb', 'cur_other_group', '']) {
			const result = schema.safeParse({ note: 'x', amountMinor: 3, currency });
			expect(result.success, `currency ${JSON.stringify(currency)} should be rejected`).toBe(false);
			// One indistinguishable message: unknown, wrong-case and another group's code
			// must not be told apart.
			expect(messageOn(result, 'currency')).toBe(UNSUPPORTED_CURRENCY_MESSAGE);
		}
	});

	it('requires amount and currency TOGETHER — either both or neither', () => {
		const amountOnly = schema.safeParse({ note: 'x', amountMinor: 120000 });
		expect(amountOnly.success).toBe(false);
		expect(messageOn(amountOnly, 'currency')).toBe('Select a currency for the amount');

		const currencyOnly = schema.safeParse({ note: 'x', currency: 'THB' });
		expect(currencyOnly.success).toBe(false);
		expect(messageOn(currencyOnly, 'amountMinor')).toBe('Enter an amount for the currency');

		expect(schema.safeParse({ note: 'x' }).success).toBe(true);
		expect(schema.safeParse({ note: 'x', amountMinor: 1, currency: 'THB' }).success).toBe(true);
	});
});

describe('buildCreateCaptureSchema — capturedFor', () => {
	it('defaults to today (UTC) when omitted', () => {
		expect(schema.parse({ note: 'x' }).capturedFor).toBe(todayUtc());
	});

	it('accepts a backdated real-world day', () => {
		expect(schema.parse({ note: 'x', capturedFor: '2026-02-28' }).capturedFor).toBe('2026-02-28');
	});

	it('rejects a non-day, an impossible day and a future day', () => {
		expect(schema.safeParse({ note: 'x', capturedFor: '28/02/2026' }).success).toBe(false);
		expect(schema.safeParse({ note: 'x', capturedFor: '2026-02-31' }).success).toBe(false);

		const future = schema.safeParse({ note: 'x', capturedFor: '2099-01-01' });
		expect(future.success).toBe(false);
		expect(messageOn(future, 'capturedFor')).toBe('The date cannot be in the future');
	});
});

describe('buildCreateCaptureSchema — the shallowness is the spec (ADR-0012)', () => {
	it('STRIPS every ledger-shaped field instead of carrying it into the row', () => {
		const result = schema.parse({
			note: 'dinner',
			amountMinor: 120000,
			currency: 'THB',
			// Everything ADR-0012 says a Capture must never hold. Submitting these is
			// how a "just a small addition" would arrive; parsing must drop them.
			splitMode: 'equal',
			payers: [{ memberId: 'm1', amountPaid: 120000 }],
			beneficiaries: ['m1', 'm2'],
			items: [{ label: 'pad thai', amount: 6000 }],
			exchangeRate: '0.0285',
			categoryId: 'spending-food',
			type: 'spending'
		});

		expect(Object.keys(result).sort()).toEqual(['amountMinor', 'capturedFor', 'currency', 'note']);
	});

	it('never lets a caller supply identity or authorship fields', () => {
		const result = schema.parse({
			note: 'dinner',
			id: 'someone-elses-id',
			groupId: 'another-group',
			createdBy: 'another-user',
			resolvedAt: '2026-01-01T00:00:00Z',
			resolvedTransactionId: 't1',
			discardedAt: '2026-01-01T00:00:00Z'
		});

		expect(result).toEqual({ note: 'dinner', capturedFor: todayUtc() });
	});
});
