import { describe, it, expect } from 'vitest';
import {
	createCustomCurrencySchema,
	customCurrencyRefSchema,
	editCustomCurrencySchema,
	updateCustomCurrencySchema,
	DISPLAY_CODE_MAX_LENGTH
} from './custom-currency';

// Unit spec for the shared custom-currency input schemas (issue #61; PLAN §7.5.2).
//
// These rules are the ONLY gate between what a member types and what the service
// stores, and they are shared verbatim with the form (#62) — so the normalization
// (trim + uppercase) and every rejection is pinned here rather than inferred from
// the service tests.

const VALID = { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 0 };

describe('createCustomCurrencySchema — displayCode (CONTEXT.md "Display code")', () => {
	it('trims and uppercases what the member typed', () => {
		const parsed = createCustomCurrencySchema.parse({ ...VALID, displayCode: '  beer  ' });
		expect(parsed.displayCode).toBe('BEER');
	});

	it('normalizes case so the per-group uniqueness rule cannot be dodged', () => {
		// Both spellings must reach the service as the SAME stored code.
		expect(createCustomCurrencySchema.parse({ ...VALID, displayCode: 'Beer' }).displayCode).toBe(
			'BEER'
		);
		expect(createCustomCurrencySchema.parse({ ...VALID, displayCode: 'bEeR' }).displayCode).toBe(
			'BEER'
		);
	});

	it('rejects an empty / whitespace-only code', () => {
		expect(createCustomCurrencySchema.safeParse({ ...VALID, displayCode: '' }).success).toBe(false);
		expect(createCustomCurrencySchema.safeParse({ ...VALID, displayCode: '   ' }).success).toBe(
			false
		);
	});

	it(`rejects a code longer than ${DISPLAY_CODE_MAX_LENGTH} characters`, () => {
		const tooLong = 'A'.repeat(DISPLAY_CODE_MAX_LENGTH + 1);
		expect(createCustomCurrencySchema.safeParse({ ...VALID, displayCode: tooLong }).success).toBe(
			false
		);
		expect(
			createCustomCurrencySchema.safeParse({
				...VALID,
				displayCode: 'A'.repeat(DISPLAY_CODE_MAX_LENGTH)
			}).success
		).toBe(true);
	});

	it('rejects interior whitespace (a display code is a token, not a phrase)', () => {
		expect(
			createCustomCurrencySchema.safeParse({ ...VALID, displayCode: 'BIG BEER' }).success
		).toBe(false);
	});

	it('accepts a non-Latin code (uppercasing is a no-op, not a rejection)', () => {
		const parsed = createCustomCurrencySchema.parse({ ...VALID, displayCode: 'เบียร์' });
		expect(parsed.displayCode).toBe('เบียร์');
	});

	it('cannot produce something shaped like an opaque code (the prefix is lowercase)', () => {
		// `CUSTOM_CURRENCY_CODE_PREFIX` is 'cur_'; uppercasing makes a typed lookalike
		// structurally distinct from a generated `code`.
		expect(createCustomCurrencySchema.parse({ ...VALID, displayCode: 'cur_x' }).displayCode).toBe(
			'CUR_X'
		);
	});
});

describe('createCustomCurrencySchema — name / symbol / exponent', () => {
	it('trims the name and the symbol', () => {
		const parsed = createCustomCurrencySchema.parse({
			...VALID,
			name: '  Bottle of beer  ',
			symbol: '  🍺  '
		});
		expect(parsed.name).toBe('Bottle of beer');
		expect(parsed.symbol).toBe('🍺');
	});

	it('requires a non-empty name and symbol', () => {
		expect(createCustomCurrencySchema.safeParse({ ...VALID, name: '  ' }).success).toBe(false);
		expect(createCustomCurrencySchema.safeParse({ ...VALID, symbol: '' }).success).toBe(false);
	});

	it('bounds the name and symbol length', () => {
		expect(createCustomCurrencySchema.safeParse({ ...VALID, name: 'x'.repeat(61) }).success).toBe(
			false
		);
		expect(createCustomCurrencySchema.safeParse({ ...VALID, symbol: 'x'.repeat(9) }).success).toBe(
			false
		);
	});

	it('accepts every exponent PLAN §7.5 supports (0–3)', () => {
		for (const exponent of [0, 1, 2, 3]) {
			expect(createCustomCurrencySchema.safeParse({ ...VALID, exponent }).success).toBe(true);
		}
	});

	it('rejects an out-of-range or non-integer exponent', () => {
		for (const exponent of [-1, 4, 2.5, Number.NaN]) {
			expect(createCustomCurrencySchema.safeParse({ ...VALID, exponent }).success).toBe(false);
		}
	});

	it('requires every field (no silent defaults)', () => {
		for (const key of ['displayCode', 'name', 'symbol', 'exponent'] as const) {
			const input: Record<string, unknown> = { ...VALID };
			delete input[key];
			expect(createCustomCurrencySchema.safeParse(input).success, `missing ${key}`).toBe(false);
		}
	});

	it('has no `code` field — the opaque PK is minted by the service, never submitted', () => {
		const parsed = createCustomCurrencySchema.parse({
			...VALID,
			code: 'cur_attacker-chosen'
		} as unknown);
		expect('code' in parsed).toBe(false);
	});
});

describe('updateCustomCurrencySchema (partial — the frozen fields may be omitted)', () => {
	it('accepts a name-only edit (what stays legal once the row is referenced)', () => {
		const parsed = updateCustomCurrencySchema.parse({ name: 'Pint of beer' });
		expect(parsed).toEqual({ name: 'Pint of beer' });
	});

	it('accepts a full resubmission, normalized the same way as create', () => {
		const parsed = updateCustomCurrencySchema.parse({ ...VALID, displayCode: ' pint ' });
		expect(parsed).toMatchObject({ displayCode: 'PINT', exponent: 0 });
	});

	it('rejects an edit with nothing in it (the audit trail would claim a change)', () => {
		expect(updateCustomCurrencySchema.safeParse({}).success).toBe(false);
	});

	it('still applies every field rule to the fields that ARE present', () => {
		expect(updateCustomCurrencySchema.safeParse({ exponent: 4 }).success).toBe(false);
		expect(updateCustomCurrencySchema.safeParse({ displayCode: '   ' }).success).toBe(false);
		expect(updateCustomCurrencySchema.safeParse({ symbol: '' }).success).toBe(false);
	});
});

describe('the manage-currencies FORM schemas (#62)', () => {
	it('editCustomCurrencySchema carries the target row plus all four fields', () => {
		const parsed = editCustomCurrencySchema.parse({ code: 'cur_beer', ...VALID });
		expect(parsed).toEqual({ code: 'cur_beer', ...VALID });
	});

	it('normalizes the edit form exactly as create does', () => {
		const parsed = editCustomCurrencySchema.parse({
			code: 'cur_beer',
			...VALID,
			displayCode: ' pint '
		});
		expect(parsed.displayCode).toBe('PINT');
	});

	it('rejects an edit that names no row — the opaque code is how a form targets one', () => {
		expect(editCustomCurrencySchema.safeParse(VALID).success).toBe(false);
		expect(editCustomCurrencySchema.safeParse({ code: '  ', ...VALID }).success).toBe(false);
	});

	it('still requires every field: an HTML form always posts all of them', () => {
		for (const key of ['displayCode', 'name', 'symbol', 'exponent'] as const) {
			const input: Record<string, unknown> = { code: 'cur_beer', ...VALID };
			delete input[key];
			expect(editCustomCurrencySchema.safeParse(input).success, `missing ${key}`).toBe(false);
		}
	});

	it('customCurrencyRefSchema is the delete target and nothing else', () => {
		expect(customCurrencyRefSchema.parse({ code: 'cur_beer' })).toEqual({ code: 'cur_beer' });
		expect(customCurrencyRefSchema.safeParse({ code: '' }).success).toBe(false);
	});

	it('the three form schemas are structurally distinct (Superforms ids derive from shape)', () => {
		const shape = (s: { safeParse: (v: unknown) => { success: boolean } }) => s;
		// create has no `code`; edit has `code` + 4 fields; the ref has ONLY `code`.
		expect(shape(createCustomCurrencySchema).safeParse({ code: 'cur_x' }).success).toBe(false);
		expect(customCurrencyRefSchema.safeParse({ code: 'cur_x' }).success).toBe(true);
		expect(editCustomCurrencySchema.safeParse({ code: 'cur_x' }).success).toBe(false);
	});
});
