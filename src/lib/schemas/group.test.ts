import { describe, it, expect } from 'vitest';
import { createGroupSchema, renameGroupSchema } from './group';

// Unit tests for the shared group create/rename input schemas (PLAN §6.1, §6.4).
// Currency-code coverage proper lives in `currency.test.ts`; here we only assert
// the group schemas reuse it (accept a valid code, reject BTC/lowercase/unknown/'').

describe('createGroupSchema', () => {
	it('trims the name and keeps a valid settlement currency', () => {
		const parsed = createGroupSchema.parse({ name: '  Trip  ', settlementCurrency: 'THB' });
		expect(parsed).toEqual({ name: 'Trip', settlementCurrency: 'THB' });
	});

	it('rejects an empty / whitespace-only name', () => {
		expect(createGroupSchema.safeParse({ name: '', settlementCurrency: 'THB' }).success).toBe(
			false
		);
		expect(createGroupSchema.safeParse({ name: '   ', settlementCurrency: 'THB' }).success).toBe(
			false
		);
	});

	it('rejects a name longer than 100 chars (after trim)', () => {
		const tooLong = 'x'.repeat(101);
		expect(createGroupSchema.safeParse({ name: tooLong, settlementCurrency: 'THB' }).success).toBe(
			false
		);
		// Exactly 100 is allowed.
		expect(
			createGroupSchema.safeParse({ name: 'x'.repeat(100), settlementCurrency: 'THB' }).success
		).toBe(true);
	});

	it('reuses currencyCodeSchema: rejects BTC, lowercase, unknown, and empty', () => {
		for (const settlementCurrency of ['BTC', 'usd', 'XXX', '']) {
			expect(
				createGroupSchema.safeParse({ name: 'Trip', settlementCurrency }).success,
				settlementCurrency
			).toBe(false);
		}
	});
});

describe('renameGroupSchema', () => {
	it('trims the name', () => {
		expect(renameGroupSchema.parse({ name: '  Roomies  ' })).toEqual({ name: 'Roomies' });
	});

	it('rejects empty / whitespace-only and too-long names', () => {
		expect(renameGroupSchema.safeParse({ name: '' }).success).toBe(false);
		expect(renameGroupSchema.safeParse({ name: '   ' }).success).toBe(false);
		expect(renameGroupSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
	});
});
