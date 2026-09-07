// The shared CALENDAR-DAY field (`YYYY-MM-DD`) and its two helpers.
//
// Extracted from `schemas/transaction.ts` when Captures (PLAN §7.7) gained a
// second real-world date, `captures.captured_for`. The two must obey the SAME
// rule, and not by coincidence: resolving a Capture prefills its date into the
// transaction form (§7.7 "Resolving"), so a day this accepts for a Capture but
// the transaction gate rejects would be a Capture that cannot be recorded on its
// own date. One field definition makes that impossible rather than merely
// unlikely.
//
// A day is deliberately NOT an instant: the precise insert time is carried by a
// separate server-stamped column on both tables (`transactions.occurred_at`,
// `captures.created_at`).

import { z } from 'zod';

/**
 * Today's calendar day as a `YYYY-MM-DD` string in UTC — the default for the
 * editable real-world date (§7.1) and the reference point for the future-date
 * guard below. UTC keeps it deterministic server-side (Vercel runs UTC); the
 * 1-day slack in the guard absorbs viewers whose local day is ahead of UTC.
 */
export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` one day after the given UTC day-string — the future-date slack bound. */
export function nextDayUtc(day: string): string {
	const d = new Date(`${day}T00:00:00.000Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/**
 * A real-world calendar day that is not in the future (what an `<input type="date">`
 * submits).
 *
 * Validates the SHAPE (a real `YYYY-MM-DD`) and rejects FUTURE days — you can't have
 * spent money tomorrow. The bound is `today + 1 day` (UTC) so a viewer whose local
 * day is already ahead of UTC is never wrongly rejected; gross typos (e.g. 2050) are.
 *
 * Carries NO default: each caller attaches `.default(todayUtc)` itself, so "the
 * field is optional" stays a per-form decision while the RULE stays shared.
 */
export const pastDayField = z
	.string()
	.trim()
	.regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter a valid date' })
	// A real calendar day (rejects 2026-02-31, 2026-13-01, …). Parsing an ISO day is
	// lenient about overflow, so round-trip and compare the rendered day. Guard the
	// NaN case first — `.toISOString()` THROWS on an invalid Date.
	.refine(
		(s) => {
			const d = new Date(`${s}T00:00:00.000Z`);
			return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
		},
		{ message: 'Enter a valid date' }
	)
	.refine((s) => s <= nextDayUtc(todayUtc()), { message: 'The date cannot be in the future' });
