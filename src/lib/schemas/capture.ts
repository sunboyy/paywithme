// Shared Capture Zod schemas (issue #49; PLAN §7.7, §9; ADR-0012).
// CLAUDE.md: "shared Zod schemas in lib/schemas/".
//
// ── THE SHALLOWNESS IS THE SPEC ──────────────────────────────────────────────
// A Capture is a record-later placeholder: free-text `note` (the only required
// content), an OPTIONAL amount + currency, and `captured_for` (the real-world
// date). There is NO payer, NO beneficiary, NO split mode, NO item and NO
// exchange rate here, and adding one is not an enhancement — a Capture that can
// hold splits is a second transaction form, with two shapes to keep correct and
// two sets of ledger invariants to maintain (ADR-0012 "It stays shallow").
//
// The object schemas are Zod's default STRIP mode, so a submitted `splitMode` /
// `payers` / `exchangeRate` key is silently dropped instead of riding along into
// the row. `capture.test.ts` asserts that, so the rule is enforced by a test and
// not only by prose.
//
// ── The amount is UNINTERPRETED ──────────────────────────────────────────────
// `amountMinor` is integer MINOR UNITS (CLAUDE.md: no floats) paired with a
// currency code, and that is all it ever is: nothing converts it, no rate is
// stored, and no settlement equivalent is derived (PLAN §7.7 "Edge cases", §8 —
// nothing that computes a balance can see a Capture). The pairing rule below is
// the only relationship between the two fields.
//
// `note` is MEMBER-AUTHORED TEXT (CONTEXT.md): these rules bound its shape and
// size, they do NOT make it trusted.

import { z } from 'zod';
import { MAX_SAFE_MINOR } from '$lib/money';
import { buildEntryCurrencySchema, type EntryCurrencyOption } from './currency';
import { pastDayField, todayUtc } from './day';

/** Cap on the stored note, matching the transaction TITLE cap it prefills on resolve. */
export const CAPTURE_NOTE_MAX_LENGTH = 200;

/**
 * The note — the ONE required field. Trimmed and non-empty AFTER trimming: a
 * whitespace-only note is what a Capture has instead of content, and a row that
 * says nothing cannot do the one job §7.7 gives it (letting the next person see
 * that this expense is already remembered, so they don't record it twice).
 *
 * Bounded at the transaction title's own cap because "Record it" prefills this
 * string as the title (§7.7 "Resolving") — a note the title field would reject is
 * a Capture that cannot be resolved as written.
 */
const noteField = z
	.string()
	.trim()
	.min(1, { message: 'A note is required' })
	.max(CAPTURE_NOTE_MAX_LENGTH, {
		message: `Note must be ${CAPTURE_NOTE_MAX_LENGTH} characters or fewer`
	});

/**
 * The optional amount, in whole MINOR UNITS of the paired currency.
 *
 * STRICTLY POSITIVE, unlike a transaction's `amount_total` (which permits 0): an
 * amount is optional here, so "0" is never the way to say "I don't know yet" —
 * omitting the field is. A stored 0 would render as "฿0.00 not recorded yet",
 * which reads as a fact rather than as a blank.
 */
const amountMinorField = z
	.number({ message: 'Enter an amount' })
	.int({ message: 'Amount must be in whole minor units' })
	.positive({ message: 'Amount must be more than zero' })
	.max(MAX_SAFE_MINOR, { message: 'Amount is out of range' });

/**
 * `captured_for` (PLAN §7.7): the real-world day the expense happened, DEFAULTING
 * to today. Same gate as a transaction's editable `created_at` (§7.1) — see
 * `schemas/day.ts` for why the two may not drift.
 */
const capturedForField = pastDayField.default(todayUtc);

/** The parsed, normalized input `createCapture` stores. */
export type CreateCaptureInput = {
	note: string;
	amountMinor?: number;
	currency?: string;
	capturedFor: string;
};

/**
 * Build the create-Capture gate for ONE group (PLAN §7.7).
 *
 * A FACTORY for the same reason `buildEntryCurrencySchema` is one (ADR-0014): the
 * permitted currency set is the 29 seeded codes plus THIS group's custom rows,
 * which is runtime data, not compile-time knowledge. `allowed` is exactly
 * `listCurrenciesForGroup`'s result, so the picker and this validator can never
 * disagree — and another group's custom code is simply absent, failing the same
 * way an unknown code does (nothing leaks about what exists elsewhere).
 *
 * Validating the code is NOT interpreting the amount: no rate is looked up and no
 * exponent is read. It only keeps the stored pair renderable and prefillable into
 * the transaction form on resolve.
 *
 * ── AMOUNT AND CURRENCY ARE BOTH-OR-NEITHER ──────────────────────────────────
 * Either both are given or neither is. `1200` with no currency cannot be rendered
 * at all (the exponent that decides where the decimal point goes belongs to the
 * currency), and a bare `THB` states nothing a Capture doesn't already imply. The
 * two are one optional fact, so they are validated as one.
 */
export function buildCreateCaptureSchema(allowed: readonly EntryCurrencyOption[]) {
	return z
		.object({
			note: noteField,
			amountMinor: amountMinorField.optional(),
			currency: buildEntryCurrencySchema(allowed).optional(),
			capturedFor: capturedForField
		})
		.superRefine((value, ctx) => {
			if (value.amountMinor !== undefined && value.currency === undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['currency'],
					message: 'Select a currency for the amount'
				});
			}
			if (value.currency !== undefined && value.amountMinor === undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['amountMinor'],
					message: 'Enter an amount for the currency'
				});
			}
		});
}
