// `/groups/[id]/captures/new` — the quick-capture screen (issue #50; PLAN §7.7,
// §10; ADR-0012).
//
// ── THE SCREEN IS JUDGED ON TAPS, NOT COMPLETENESS ───────────────────────────
// One screen, ONE required field (the note). The amount + currency and the date
// are optional, and the date already carries today. That is the whole feature: if
// this form ever grows a payer, a beneficiary or a split it has become a second
// transaction form, which is exactly what ADR-0012 rejects. Nothing is added here
// that `createCapture` would not store.
//
// ── WHY THIS ROUTE READS `FormData` INSTEAD OF USING SUPERFORMS ──────────────
// Same reason `/settings/receiving` does, arrived at from the other direction: the
// shared schema takes `amountMinor` in integer MINOR UNITS, but a form posts a
// MAJOR-unit string ("1,200.50") whose scale is decided by the currency picker at
// runtime. The transaction form solves that on the CLIENT — it parses to minor
// units into a hidden field — which means its amount does not survive with
// JavaScript off. This screen must, so the major → minor conversion happens HERE,
// server-side, through the same `lib/money` `parseAmount` (no floats, the
// currency's own exponent).
//
// Everything else still goes through the ONE shared gate: the route never
// re-implements a validation rule, it hands an input object to `createCapture`,
// which parses it with `buildCreateCaptureSchema` and reports back issues this
// route only has to re-key onto its fields.
//
// ── AMOUNT AND CURRENCY ARE SUBMITTED AS ONE FACT ────────────────────────────
// The picker always holds a value (the group's currency), so a blank amount would
// post a lone currency and trip the schema's both-or-neither rule on every
// note-only Capture — the common case. So the currency is only forwarded when an
// amount was actually typed; a blank amount posts NEITHER, which is what "I don't
// know yet" means (see `schemas/capture.ts` on why 0 is not that).

import { error, fail, redirect } from '@sveltejs/kit';
import type { z } from 'zod';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { pathAndQuery } from '$lib/redirect';
import { GroupAccessError } from '$lib/server/groups';
import { createCapture, CaptureValidationError } from '$lib/server/captures';
import { loadEntryCurrencies, toCurrencyOptions } from '$lib/server/transaction-page';
import { parseAmount, type SeededCurrencyCode } from '$lib/money';
import { CAPTURE_NOTE_MAX_LENGTH } from '$lib/schemas/capture';
import { todayUtc } from '$lib/schemas/day';
import { UNSUPPORTED_CURRENCY_MESSAGE } from '$lib/schemas/currency';
import type { Actions, PageServerLoad } from './$types';

/** What the form posts, as strings — a rejected submit re-renders from exactly this. */
export type CaptureFormValues = {
	note: string;
	/** MAJOR units as typed ("1,200.50"), never minor units. */
	amount: string;
	currency: string;
	capturedFor: string;
};

/** What the action hands back on anything other than a redirect. */
export type CaptureFormOutcome = {
	/** Messages keyed by FORM field name, rendered against the inputs. */
	fieldErrors?: Record<string, string[] | undefined>;
	values: CaptureFormValues;
	/** A whole-form message (never a per-field rule). */
	message?: { type: 'error'; text: string };
};

export const load: PageServerLoad = async ({ params, locals, url }) => {
	// Centralized guard: anonymous → login; no-access/not-found → 404. THROWS
	// control flow, so it stays outside any try/catch.
	const { user, group } = await requireGroupAccess({
		locals,
		groupId: params.id,
		redirectTo: pathAndQuery(url)
	});

	const settlementCurrency = group.settlementCurrency as SeededCurrencyCode;

	// The group's permitted currency set (PLAN §7.5.2): the seeded 29 plus this
	// group's own rows. One read feeds the picker AND the exponent the action parses
	// the typed amount at, so the two cannot disagree about what may be recorded.
	const entryCurrencies = await loadEntryCurrencies(user.id, params.id, 'Group not found');

	return {
		group: { id: group.id, name: group.name, settlementCurrency },
		currencies: toCurrencyOptions(entryCurrencies),
		values: {
			note: '',
			amount: '',
			// Defaults to the GROUP's currency (PLAN §7.7) — the one you are most
			// likely to have just spent.
			currency: settlementCurrency,
			// Defaults to today (§7.7); the field stays editable for "that was Saturday".
			capturedFor: todayUtc()
		} satisfies CaptureFormValues,
		noteMaxLength: CAPTURE_NOTE_MAX_LENGTH
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals, url }) => {
		// Guard the mutation too — never trust that `load` ran. THROWS the redirect.
		const user = requireUser(locals, { redirectTo: pathAndQuery(url) });

		const data = await request.formData();
		const values: CaptureFormValues = {
			note: readString(data, 'note'),
			amount: readString(data, 'amount').trim(),
			currency: readString(data, 'currency'),
			capturedFor: readString(data, 'capturedFor').trim()
		};

		// Re-read the group's currency set server-side (this also re-checks access):
		// the exponent an amount is parsed at must come from TRUSTED context, never
		// from the submission.
		const entryCurrencies = await loadEntryCurrencies(user.id, params.id, 'Group not found');

		// Optional money, as ONE fact. `money` stays undefined for a note-only
		// Capture; a parse failure is a field error, not a 500.
		let money: { amountMinor: number; currency: string } | undefined;
		if (values.amount !== '') {
			const descriptor = entryCurrencies.find((c) => c.code === values.currency);
			if (!descriptor) {
				// An unknown code can only be a tampered post (the picker offers this
				// group's set). Same indistinguishable message the shared gate uses, so
				// another group's custom code leaks nothing.
				return rejected(values, { currency: [UNSUPPORTED_CURRENCY_MESSAGE] });
			}
			try {
				money = { amountMinor: parseAmount(values.amount, descriptor), currency: descriptor.code };
			} catch {
				// `parseAmount`'s own messages name the exponent and echo the input;
				// the field says the one thing the user can act on.
				return rejected(values, { amount: ['Enter a valid amount'] });
			}
		}

		try {
			await createCapture({
				userId: user.id,
				groupId: params.id,
				input: {
					note: values.note,
					...money,
					// Blank → omitted, so the schema's own "today" default applies rather
					// than this route inventing a second one.
					capturedFor: values.capturedFor === '' ? undefined : values.capturedFor
				}
			});
		} catch (e) {
			if (e instanceof GroupAccessError) {
				error(404, 'Group not found');
			}
			if (e instanceof CaptureValidationError) {
				return rejected(values, toFieldErrors(e.issues));
			}
			// Never leak the raw cause (PLAN §12).
			const outcome: CaptureFormOutcome = {
				values,
				message: { type: 'error', text: 'Could not save that. Please try again.' }
			};
			return fail(500, outcome);
		}

		// Land on the tray, not back on the group overview: the point of the screen is
		// that what you just wrote is now VISIBLE to the group (§7.7 deduplication),
		// and the tray is where it is visible. A redirect also means a reload can't
		// re-post it. `redirect()` THROWS — outside the try/catch above.
		redirect(303, `/groups/${params.id}/transactions`);
	}
};

/** A 400 that re-renders the form filled in, with messages against its fields. */
function rejected(values: CaptureFormValues, fieldErrors: Record<string, string[]>) {
	const outcome: CaptureFormOutcome = { values, fieldErrors };
	return fail(400, outcome);
}

/** One submitted string field; a missing value (or a file) reads as `''`. */
function readString(data: FormData, name: string): string {
	const value = data.get(name);
	return typeof value === 'string' ? value : '';
}

/**
 * Re-key the shared schema's issues onto the FORM's field names.
 *
 * Only one differs, and it differs for a reason: the schema field is `amountMinor`
 * (integer minor units) while the input the user types into is `amount` (major
 * units). Attaching the message to `amountMinor` would render it against nothing.
 */
function toFieldErrors(issues: readonly z.core.$ZodIssue[]): Record<string, string[]> {
	const errors: Record<string, string[]> = {};
	for (const issue of issues) {
		const path = String(issue.path[0] ?? '');
		const field = path === 'amountMinor' ? 'amount' : path;
		if (field === '') continue;
		(errors[field] ??= []).push(issue.message);
	}
	return errors;
}
