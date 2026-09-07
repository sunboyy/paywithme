// The rail registry (PLAN §17.2; ADR-0016) — the single place that answers
// "which rails exist?", "what may this rail's `details` contain?" and "how is it
// rendered?".
//
// Storage is rail-agnostic on purpose: `receiving_method` holds `rail` (text) and
// `details` (jsonb), and the database is never taught the shape of either. This
// module is the whole enforcement: an UNKNOWN RAIL KEY IS REJECTED, so `details`
// that no registry entry can validate is never written and never rendered.
//
// Adding a country later is one entry in the map below — no migration, no enum
// change, no `switch` to rewrite (which is exactly what an enum would have cost;
// see ADR-0016).

import type { z } from 'zod';
import { thBankAccountRail } from './th-bank-account';
import { thPromptPayRail } from './th-promptpay';
import { otherRail } from './other';
import type { PayoutRail, RailQrRequest } from './types';

export type { PayoutRail, RailQrRequest } from './types';

/**
 * Every rail, keyed by the id stored in `receiving_method.rail`.
 *
 * Insertion order is the order a picker should offer them; `other` is last
 * because it is the fallback, not because the two Thai rails outrank each other —
 * no rail is privileged in code.
 *
 * The keys are written as LITERALS rather than as `[rail.id]:` so {@link RailId}
 * below is a union and not `string`; a unit test asserts every key equals its
 * entry's own `id`, which is what keeps the two spellings from drifting.
 */
export const PAYOUT_RAILS = {
	th_bank_account: thBankAccountRail,
	th_promptpay: thPromptPayRail,
	other: otherRail
} as const satisfies Record<string, PayoutRail>;

/** A registry key — the value space of `receiving_method.rail`. */
export type RailId = keyof typeof PAYOUT_RAILS;

/** Every rail id, in the registry's display order. */
export const RAIL_IDS = Object.keys(PAYOUT_RAILS) as RailId[];

/** Every rail entry, in the registry's display order (for pickers). */
export const RAILS: readonly PayoutRail[] = RAIL_IDS.map((id) => PAYOUT_RAILS[id]);

/** Is this string a rail the registry knows? Narrows before any lookup. */
export function isRailId(value: unknown): value is RailId {
	return typeof value === 'string' && Object.hasOwn(PAYOUT_RAILS, value);
}

/** The registry entry for `rail`, or `undefined` when the key is unknown. */
export function findRail(rail: string): PayoutRail | undefined {
	return isRailId(rail) ? PAYOUT_RAILS[rail] : undefined;
}

/** Thrown by {@link getRail} / {@link formatRailDetails} for a key no entry owns. */
export class UnknownRailError extends Error {
	readonly rail: string;

	constructor(rail: string) {
		super(`Unknown receiving-method rail: ${rail}`);
		this.name = 'UnknownRailError';
		this.rail = rail;
	}
}

/**
 * The registry entry for `rail`, or a throw.
 *
 * For a rail id that is already known to be valid (a stored row, a value that has
 * been through {@link parseRailDetails}). Validate CALLER-SUPPLIED keys with
 * {@link parseRailDetails} instead — an unknown rail from a form is a rejected
 * submission, not an exception.
 */
export function getRail(rail: string): PayoutRail {
	const entry = findRail(rail);
	if (!entry) throw new UnknownRailError(rail);
	return entry;
}

/** The outcome of validating a caller-supplied `(rail, details)` pair. */
export type ParsedRailDetails =
	| { success: true; rail: RailId; details: unknown }
	| { success: false; reason: 'unknown_rail' }
	| { success: false; reason: 'invalid_details'; error: z.ZodError };

/**
 * Validate a `(rail, details)` pair against the registry — the ONE gate every
 * write goes through.
 *
 * Returns the PARSED details (trimmed and stripped of unknown keys by the rail's
 * schema), which is what belongs in the jsonb column: never the raw submission,
 * so a stray field can't ride along into storage.
 */
export function parseRailDetails(rail: string, details: unknown): ParsedRailDetails {
	const entry = findRail(rail);
	if (!entry) return { success: false, reason: 'unknown_rail' };

	const parsed = entry.detailsSchema.safeParse(details);
	if (!parsed.success) return { success: false, reason: 'invalid_details', error: parsed.error };

	return { success: true, rail: rail as RailId, details: parsed.data };
}

/**
 * Render stored `details` for `rail` as one human-readable line.
 *
 * Throws for an unknown rail, and (via the entry's formatter) for details its own
 * schema rejects — a receiving method that cannot be rendered correctly must not
 * be rendered at all: the payer is about to copy it into a transfer.
 */
export function formatRailDetails(rail: string, details: unknown): string {
	return getRail(rail).format(details);
}

/**
 * The scannable payload for one transfer into this method, or `null` (issue #88).
 *
 * `null` is the ordinary answer and covers every way a code cannot be produced:
 * an unknown rail, a rail with no encoder at all (`th_bank_account`, `other` —
 * see {@link PayoutRail.encodeQr}), details the rail no longer accepts, a
 * currency it cannot carry, or an amount it cannot express. The caller renders a
 * code when it gets one and the details alone when it does not — WITHOUT asking
 * which rail this is, which is what keeps "no rail is privileged" true on the
 * read surfaces too.
 */
export function buildRailQr(rail: string, details: unknown, request: RailQrRequest): string | null {
	return findRail(rail)?.encodeQr?.(details, request) ?? null;
}
