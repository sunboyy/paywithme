import { describe, it, expect } from 'vitest';
import {
	ACCOUNT_HOLDER_NAME_MAX_LENGTH,
	ACCOUNT_NUMBER_MAX_DIGITS,
	ACCOUNT_NUMBER_MIN_DIGITS,
	OTHER_LABEL_MAX_LENGTH,
	OTHER_TEXT_MAX_LENGTH,
	PROMPTPAY_PROXY_TYPES,
	PROXY_VALUE_MAX_DIGITS,
	PROXY_VALUE_MIN_DIGITS,
	THAI_BANKS,
	otherDetailsSchema,
	thBankAccountDetailsSchema,
	thPromptPayDetailsSchema,
	thaiBankName
} from './receiving-method';

// Unit spec for the per-rail `details` schemas (issue #83; PLAN §17.2).
//
// The load-bearing rules, and why each one is here:
//   - the account holder name is REQUIRED and non-empty AFTER TRIM on both Thai
//     rails — it is the only check that catches a valid-but-wrong account number;
//   - `other` is accepted WITHOUT one, because there is nothing to compare;
//   - the number/proxy fields are DIGITS ONLY within a plausible range, so letters,
//     spaces, punctuation and out-of-range lengths are rejected — and nothing
//     narrower is asserted, since per-bank rules are exactly what §17.2 forbids.

/** A holder name that is only whitespace of assorted kinds. */
const WHITESPACE_ONLY = '  \t \n ';

const validBankAccount = {
	bank: 'kbank',
	accountNumber: '1234567890',
	accountHolderName: 'Somchai Jaidee'
};

const validPromptPay = {
	proxyType: 'mobile',
	proxyValue: '0812345678',
	accountHolderName: 'สมชาย ใจดี'
};

describe('THAI_BANKS (owned by the th_bank_account rail)', () => {
	it('is a non-empty list of unique, stable ids', () => {
		expect(THAI_BANKS.length).toBeGreaterThan(0);
		const ids = THAI_BANKS.map((bank) => bank.id);
		expect(new Set(ids).size).toBe(ids.length);
		// Ids are STORED in `details.bank`, so they must be plain, lowercase tokens
		// that never need escaping or renaming.
		for (const id of ids) expect(id).toMatch(/^[a-z0-9]+$/);
		for (const bank of THAI_BANKS) expect(bank.name.trim()).not.toBe('');
	});

	it('resolves a display name for a shipped id only', () => {
		expect(thaiBankName('kbank')).toBe('Kasikornbank (KBank)');
		expect(thaiBankName('not-a-bank')).toBeUndefined();
	});
});

describe('thBankAccountDetailsSchema', () => {
	it('accepts a valid payload', () => {
		const parsed = thBankAccountDetailsSchema.parse(validBankAccount);
		expect(parsed).toEqual(validBankAccount);
	});

	it('trims the holder name and drops unknown keys', () => {
		const parsed = thBankAccountDetailsSchema.parse({
			...validBankAccount,
			accountHolderName: '  Somchai Jaidee  ',
			// A stray field must never ride along into the jsonb column.
			isDefault: true
		});
		expect(parsed).toEqual(validBankAccount);
	});

	it('rejects a missing holder name', () => {
		const result = thBankAccountDetailsSchema.safeParse({
			bank: validBankAccount.bank,
			accountNumber: validBankAccount.accountNumber
		});
		expect(result.success).toBe(false);
	});

	it('rejects a whitespace-only holder name (empty AFTER trim)', () => {
		const result = thBankAccountDetailsSchema.safeParse({
			...validBankAccount,
			accountHolderName: WHITESPACE_ONLY
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0].message).toBe('Account holder name is required');
	});

	it('caps the holder name length', () => {
		const tooLong = 'ก'.repeat(ACCOUNT_HOLDER_NAME_MAX_LENGTH + 1);
		expect(
			thBankAccountDetailsSchema.safeParse({ ...validBankAccount, accountHolderName: tooLong })
				.success
		).toBe(false);
		expect(
			thBankAccountDetailsSchema.safeParse({
				...validBankAccount,
				accountHolderName: tooLong.slice(0, ACCOUNT_HOLDER_NAME_MAX_LENGTH)
			}).success
		).toBe(true);
	});

	it('rejects an account number that is not digits only', () => {
		for (const accountNumber of [
			'12345678AB', // letters
			'123 456 7890', // interior spaces
			'123-4-56789-0', // punctuation (how a passbook prints it)
			'๑๒๓๔๕๖๗๘๙๐', // Thai digits — not [0-9]
			'+66812345678',
			''
		]) {
			expect(
				thBankAccountDetailsSchema.safeParse({ ...validBankAccount, accountNumber }).success,
				`expected ${JSON.stringify(accountNumber)} to be rejected`
			).toBe(false);
		}
	});

	it('gives ONE message per rejected account number, not the whole rule list', () => {
		// The editor renders a field's messages joined into one paragraph, so without
		// the aborting checks a blank field read "Account number is required. Account
		// number must contain digits only. Account number must be 6–20 digits".
		const cases: [string, string][] = [
			['', 'Account number is required'],
			['12-34', 'Account number must contain digits only'],
			['123', 'Account number must be 6–20 digits']
		];
		for (const [accountNumber, message] of cases) {
			const result = thBankAccountDetailsSchema.safeParse({ ...validBankAccount, accountNumber });
			const issues = result.error?.issues ?? [];
			expect(
				issues.map((issue) => issue.message),
				accountNumber
			).toEqual([message]);
		}
	});

	it('rejects an account number outside the plausible length range', () => {
		const tooShort = '1'.repeat(ACCOUNT_NUMBER_MIN_DIGITS - 1);
		const tooLong = '1'.repeat(ACCOUNT_NUMBER_MAX_DIGITS + 1);
		expect(
			thBankAccountDetailsSchema.safeParse({ ...validBankAccount, accountNumber: tooShort }).success
		).toBe(false);
		expect(
			thBankAccountDetailsSchema.safeParse({ ...validBankAccount, accountNumber: tooLong }).success
		).toBe(false);
	});

	it('accepts both ends of the range, and every shipped bank', () => {
		for (const digits of [ACCOUNT_NUMBER_MIN_DIGITS, ACCOUNT_NUMBER_MAX_DIGITS]) {
			expect(
				thBankAccountDetailsSchema.safeParse({
					...validBankAccount,
					accountNumber: '1'.repeat(digits)
				}).success
			).toBe(true);
		}
		// No per-bank format rule: the SAME number is valid at every bank (§17.2).
		for (const bank of THAI_BANKS) {
			expect(
				thBankAccountDetailsSchema.safeParse({ ...validBankAccount, bank: bank.id }).success,
				bank.id
			).toBe(true);
		}
	});

	it('rejects a bank that is not on the shipped list', () => {
		expect(
			thBankAccountDetailsSchema.safeParse({ ...validBankAccount, bank: 'chase' }).success
		).toBe(false);
	});
});

describe('thPromptPayDetailsSchema', () => {
	it('accepts a valid payload, including a Thai-script holder name', () => {
		expect(thPromptPayDetailsSchema.parse(validPromptPay)).toEqual(validPromptPay);
	});

	it('accepts every proxy type', () => {
		const value = {
			mobile: '0812345678',
			national_id: '1234567890123',
			ewallet: '123456789012345'
		};
		for (const proxyType of PROMPTPAY_PROXY_TYPES) {
			expect(
				thPromptPayDetailsSchema.safeParse({
					...validPromptPay,
					proxyType,
					proxyValue: value[proxyType]
				}).success,
				proxyType
			).toBe(true);
		}
	});

	it('has no `bank_account` proxy type in v1', () => {
		// Whether an account-number QR scans is a QR-encoding question (#82); if it
		// works, that QR comes from a `th_bank_account` row — so no proxy type here.
		expect(PROMPTPAY_PROXY_TYPES).not.toContain('bank_account');
		expect(
			thPromptPayDetailsSchema.safeParse({ ...validPromptPay, proxyType: 'bank_account' }).success
		).toBe(false);
	});

	it('rejects a missing or whitespace-only holder name', () => {
		expect(
			thPromptPayDetailsSchema.safeParse({
				proxyType: validPromptPay.proxyType,
				proxyValue: validPromptPay.proxyValue
			}).success
		).toBe(false);
		const blank = thPromptPayDetailsSchema.safeParse({
			...validPromptPay,
			accountHolderName: WHITESPACE_ONLY
		});
		expect(blank.success).toBe(false);
		expect(blank.error?.issues[0].message).toBe('Account holder name is required');
	});

	it('rejects a proxy value that is not digits only or is out of range', () => {
		for (const proxyValue of [
			'081-234-5678',
			'081 234 5678',
			'+66812345678',
			'ewallet@example.com',
			'1'.repeat(PROXY_VALUE_MIN_DIGITS - 1),
			'1'.repeat(PROXY_VALUE_MAX_DIGITS + 1)
		]) {
			expect(
				thPromptPayDetailsSchema.safeParse({ ...validPromptPay, proxyValue }).success,
				`expected ${JSON.stringify(proxyValue)} to be rejected`
			).toBe(false);
		}
	});
});

describe('otherDetailsSchema', () => {
	it('accepts a payload with NO holder name (nothing to compare)', () => {
		const parsed = otherDetailsSchema.parse({
			label: 'Wise (EUR)',
			text: 'IBAN DE89 3704 0044 0532 0130 00'
		});
		expect(parsed).toEqual({ label: 'Wise (EUR)', text: 'IBAN DE89 3704 0044 0532 0130 00' });
		expect(parsed).not.toHaveProperty('accountHolderName');
	});

	it('drops a holder name if one is submitted anyway', () => {
		const parsed = otherDetailsSchema.parse({
			label: 'Wise',
			text: 'anything at all',
			accountHolderName: 'Somchai Jaidee'
		});
		expect(parsed).not.toHaveProperty('accountHolderName');
	});

	it('applies NO format validation to the free text', () => {
		// Letters, punctuation, URLs, newlines, emoji: all fine. The app cannot know
		// what a foreign account looks like, so it does not guess (§17.2).
		for (const text of [
			'paypal.me/somchai',
			'Sort code 12-34-56, acct 12345678',
			'ask me on LINE 🙂',
			'line 1\nline 2'
		]) {
			expect(otherDetailsSchema.safeParse({ label: 'Other', text }).success, text).toBe(true);
		}
	});

	it('still requires a non-empty label and text, and bounds their size', () => {
		expect(otherDetailsSchema.safeParse({ label: '   ', text: 'x' }).success).toBe(false);
		expect(otherDetailsSchema.safeParse({ label: 'x', text: '   ' }).success).toBe(false);
		expect(otherDetailsSchema.safeParse({ label: 'x' }).success).toBe(false);
		expect(
			otherDetailsSchema.safeParse({ label: 'a'.repeat(OTHER_LABEL_MAX_LENGTH + 1), text: 'x' })
				.success
		).toBe(false);
		expect(
			otherDetailsSchema.safeParse({ label: 'x', text: 'a'.repeat(OTHER_TEXT_MAX_LENGTH + 1) })
				.success
		).toBe(false);
	});
});
