// Shared receiving-method Zod schemas (CLAUDE.md: "shared Zod schemas in
// lib/schemas/"; PLAN §17.2 "its Zod schema in lib/schemas/").
//
// One schema per RAIL (PLAN §17.2). Each describes the `details` jsonb of a
// `receiving_method` row and nothing else: the row's `rail`, `position` and
// `user_id` are storage/ordering concerns, never member-authored payload, so they
// are not modelled here. The rail REGISTRY that pairs each schema with its label
// and its formatter lives in `lib/server/payout-rails/` — a schema on its own can
// validate but cannot name or render itself.
//
// ── Validation is loose on the number and strict on the name (PLAN §17.2) ─────
// The account number / PromptPay proxy value are checked for DIGITS ONLY within a
// plausible length range. There are deliberately NO per-bank and no per-proxy-type
// format rules: they go stale silently and start rejecting valid new formats,
// while catching nothing that matters — no format check can catch a *valid but
// wrong* number, and a transposed digit that lands on a real account sends real
// money to a stranger.
//
// What catches that is the payer comparing the account holder name their banking
// app shows against the name shown here, which is why `accountHolderName` is
// REQUIRED and non-empty after trim on both Thai rails. It is a THIRD, distinct
// name string next to `user.name` and `members.display_name`: it is whatever the
// bank has on record, may be in Thai, and is NEVER defaulted from either of the
// others.
//
// `other` carries no holder name at all — it is free-form text for a rail we
// don't model (a foreign bank, a payment link), so there is nothing to compare
// and nothing to format.
//
// All fields here are MEMBER-AUTHORED TEXT (CONTEXT.md): these rules bound their
// shape and size, they do NOT make the text trusted.

import { z } from 'zod';

/** One shipped Thai bank the `th_bank_account` rail can name. */
export interface ThaiBank {
	/**
	 * Stable identifier, STORED in `details.bank`. Never a random id and never
	 * renamed: existing rows hold this string, so an entry may be ADDED to the list
	 * below but must not be removed or re-keyed (same rule as the category slugs in
	 * `lib/categories.ts`).
	 */
	readonly id: string;
	/** Display name, e.g. `'Kasikornbank (KBank)'`. Free to change — nothing stores it. */
	readonly name: string;
}

/**
 * The shipped list of Thai banks — the value space of `th_bank_account`'s `bank`
 * field (PLAN §17.2 "bank (shipped list of Thai banks)").
 *
 * OWNED BY THE `th_bank_account` RAIL. Nothing else in the app reads it: no other
 * rail, no group, no ledger code. It sits beside that rail's schema because a
 * schema that validates `bank` has to know the values; it is deliberately NOT a
 * table and NOT a seeded row (unlike currencies, ADR-0014) — rails are only ever
 * shipped by us, so a constant is the whole mechanism. Adding a bank is an edit to
 * this array: no migration, no seed, no touching existing rows.
 *
 * Array order is DISPLAY order (roughly by retail prominence in Thailand), which
 * is why it isn't alphabetical.
 */
export const THAI_BANKS = [
	{ id: 'kbank', name: 'Kasikornbank (KBank)' },
	{ id: 'scb', name: 'Siam Commercial Bank (SCB)' },
	{ id: 'ktb', name: 'Krungthai Bank (KTB)' },
	{ id: 'bbl', name: 'Bangkok Bank (BBL)' },
	{ id: 'bay', name: 'Bank of Ayudhya (Krungsri)' },
	{ id: 'ttb', name: 'TMBThanachart Bank (ttb)' },
	{ id: 'gsb', name: 'Government Savings Bank (GSB)' },
	{ id: 'baac', name: 'Bank for Agriculture and Agricultural Cooperatives (BAAC)' },
	{ id: 'kkp', name: 'Kiatnakin Phatra Bank (KKP)' },
	{ id: 'cimbt', name: 'CIMB Thai Bank' },
	{ id: 'lhb', name: 'Land and Houses Bank (LH Bank)' },
	{ id: 'tisco', name: 'TISCO Bank' },
	{ id: 'uobt', name: 'UOB Thailand' },
	{ id: 'ghb', name: 'Government Housing Bank (GHB)' },
	{ id: 'ibank', name: 'Islamic Bank of Thailand' },
	{ id: 'tcrb', name: 'Thai Credit Bank' },
	{ id: 'icbct', name: 'ICBC (Thai)' }
] as const satisfies readonly ThaiBank[];

/** A `THAI_BANKS` id — the literal union stored in `details.bank`. */
export type ThaiBankId = (typeof THAI_BANKS)[number]['id'];

/** Display name for a stored bank id, or `undefined` if the id is not shipped. */
export function thaiBankName(id: string): string | undefined {
	return THAI_BANKS.find((bank) => bank.id === id)?.name;
}

// `z.enum` needs a non-empty tuple type; the list above is a non-empty `as const`
// array, so this assertion keeps the enum in lockstep with the data rather than
// re-typing every id (same trick as `schemas/currency.ts`), while still parsing to
// the `ThaiBankId` literal union.
const thaiBankIdTuple = THAI_BANKS.map((bank) => bank.id) as unknown as [
	ThaiBankId,
	...ThaiBankId[]
];

/** Cap on the stored account holder name, matching the member display-name cap. */
export const ACCOUNT_HOLDER_NAME_MAX_LENGTH = 100;

/**
 * The account holder name rule, shared by both Thai rails so their messages can
 * never drift. Required, trimmed, non-empty AFTER trimming — a whitespace-only
 * name is rejected, not stored, because a blank name silently removes the ONE
 * check that catches a valid-but-wrong account number (PLAN §17.2).
 */
const accountHolderNameField = z
	.string()
	.trim()
	.min(1, { message: 'Account holder name is required' })
	.max(ACCOUNT_HOLDER_NAME_MAX_LENGTH, {
		message: `Account holder name must be ${ACCOUNT_HOLDER_NAME_MAX_LENGTH} characters or fewer`
	});

/** Plausible-length bounds for a bank account number (digits only). */
export const ACCOUNT_NUMBER_MIN_DIGITS = 6;
export const ACCOUNT_NUMBER_MAX_DIGITS = 20;

/** Plausible-length bounds for a PromptPay proxy value (digits only). */
export const PROXY_VALUE_MIN_DIGITS = 9;
export const PROXY_VALUE_MAX_DIGITS = 15;

/**
 * A digits-only field within `[min, max]` digits.
 *
 * Outer whitespace is trimmed (as everywhere else in `lib/schemas`), then the
 * value must be digits and nothing else: an INTERIOR space, a dash, a `+`, a
 * letter — the shapes people paste from a banking app — are all rejected, so what
 * is stored is exactly what the payer types into their transfer form.
 *
 * The checks ABORT in order, so one value yields one message. Without that, a
 * blank field fails all three and the editor renders "… is required. … must
 * contain digits only. … must be 6–20 digits" as a single paragraph.
 */
function digitsField(options: { label: string; min: number; max: number }) {
	const { label, min, max } = options;
	return z
		.string()
		.trim()
		.min(1, { message: `${label} is required`, abort: true })
		.regex(/^[0-9]+$/, { message: `${label} must contain digits only`, abort: true })
		.refine((value) => value.length >= min && value.length <= max, {
			message: `${label} must be ${min}–${max} digits`
		});
}

/**
 * `th_bank_account` details — a shipped bank, an account number, and the holder
 * name the payer is told to compare (PLAN §17.2).
 */
export const thBankAccountDetailsSchema = z.object({
	bank: z.enum(thaiBankIdTuple, { message: 'Select a bank' }),
	accountNumber: digitsField({
		label: 'Account number',
		min: ACCOUNT_NUMBER_MIN_DIGITS,
		max: ACCOUNT_NUMBER_MAX_DIGITS
	}),
	accountHolderName: accountHolderNameField
});

/** Parsed, normalized `th_bank_account` details. */
export type ThBankAccountDetails = z.infer<typeof thBankAccountDetailsSchema>;

/**
 * The PromptPay proxies a v1 method may name.
 *
 * There is deliberately NO `bank_account` proxy type: whether a QR can be built
 * over an account-number proxy is purely a QR-encoding question (the spike in
 * ADR-0016), and if it works that QR is generated from a `th_bank_account` row —
 * which needs no new proxy type here, so the spike's outcome forces no migration
 * either way.
 */
export const PROMPTPAY_PROXY_TYPES = ['mobile', 'national_id', 'ewallet'] as const;

/** A PromptPay proxy type — the literal union stored in `details.proxyType`. */
export type PromptPayProxyType = (typeof PROMPTPAY_PROXY_TYPES)[number];

/** Display label for each proxy type, used when rendering stored details. */
export const PROMPTPAY_PROXY_TYPE_LABELS: Record<PromptPayProxyType, string> = {
	mobile: 'Mobile number',
	national_id: 'National ID',
	ewallet: 'e-Wallet ID'
};

/**
 * `th_promptpay` details — a proxy type, its value, and the holder name (PLAN §17.2).
 *
 * ONE length range covers all three proxy types (mobile 10, national ID 13,
 * e-wallet 15 digits today) rather than a per-type rule, for the same reason there
 * are no per-bank rules: a tighter rule buys nothing and goes stale silently.
 */
export const thPromptPayDetailsSchema = z.object({
	proxyType: z.enum(PROMPTPAY_PROXY_TYPES, { message: 'Select a PromptPay type' }),
	proxyValue: digitsField({
		label: 'PromptPay number',
		min: PROXY_VALUE_MIN_DIGITS,
		max: PROXY_VALUE_MAX_DIGITS
	}),
	accountHolderName: accountHolderNameField
});

/** Parsed, normalized `th_promptpay` details. */
export type ThPromptPayDetails = z.infer<typeof thPromptPayDetailsSchema>;

/** Caps on the free-text `other` rail, to bound what a row can store. */
export const OTHER_LABEL_MAX_LENGTH = 60;
export const OTHER_TEXT_MAX_LENGTH = 500;

/**
 * `other` details — a label and free text, for a rail this app does not model
 * (PLAN §17.2). NO FORMAT VALIDATION: the app cannot know what a foreign account
 * or a payment link looks like, so it does not guess. Both fields are still
 * required non-empty (a method that says nothing tells the payer nothing) and
 * bounded in size.
 *
 * NO holder name and NO QR, ever — there is nothing here to compare a bank's
 * record against, and nothing to encode.
 */
export const otherDetailsSchema = z.object({
	label: z
		.string()
		.trim()
		.min(1, { message: 'A label is required' })
		.max(OTHER_LABEL_MAX_LENGTH, {
			message: `Label must be ${OTHER_LABEL_MAX_LENGTH} characters or fewer`
		}),
	text: z
		.string()
		.trim()
		.min(1, { message: 'Payment details are required' })
		.max(OTHER_TEXT_MAX_LENGTH, {
			message: `Payment details must be ${OTHER_TEXT_MAX_LENGTH} characters or fewer`
		})
});

/** Parsed, normalized `other` details. */
export type OtherDetails = z.infer<typeof otherDetailsSchema>;
