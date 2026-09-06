// The shape of one rail registry entry, and the helper that builds one
// (PLAN §17.2; ADR-0016).
//
// A rail is the payment network a receiving method rides. Each entry owns its own
// field schema, display label and display formatter, because these vary by country
// and cannot be generalised — QR-with-amount alone has no universal encoding
// (Thai QR and PIX are EMVCo, the EU's EPC069-12 is plain text and IBAN-only,
// India is a `upi://` URI), so the field schema a QR reads from is per-country by
// construction. That is why the rail is a CODE REGISTRY and not a `promptpay |
// bank_account | other` enum: adding a country later is one new entry, with no
// migration, no enum change and no touching existing rows.
//
// No rail is privileged: `th_promptpay` is one entry beside `th_bank_account`, and
// nothing in this module or its callers branches on a specific rail id.

import type { z } from 'zod';
import type { RailField } from '$lib/payout-rail-fields';

/**
 * A registry entry, with its `details` type ERASED.
 *
 * The erasure is deliberate. A stored `details` value is `unknown` at every
 * boundary that matters (a jsonb column, a form submission, an id from a URL), so
 * a registry the caller can iterate has to be uniform; per-rail typing lives
 * INSIDE each entry, where {@link defineRail} keeps it honest.
 */
export interface PayoutRail {
	/** The registry key, stored verbatim in `receiving_method.rail` (e.g. `'th_bank_account'`). */
	readonly id: string;
	/** Human-readable rail name for pickers and headings (e.g. `'Thai bank account'`). */
	readonly label: string;
	/** The rail's field schema (authored in `lib/schemas/receiving-method.ts`). */
	readonly detailsSchema: z.ZodType;
	/**
	 * How to RENDER this rail's fields — one descriptor per key of
	 * `detailsSchema`, in form order (issue #85).
	 *
	 * Pure data (`$lib/payout-rail-fields`), so `load` can hand it to the editor
	 * and the editor can walk it. This is what lets `/settings/receiving` build an
	 * add/edit form for a rail it has never heard of: it branches on a field's
	 * CONTROL, never on the rail. A drift guard in `index.test.ts` asserts these
	 * names are exactly the schema's keys.
	 */
	readonly fields: readonly RailField[];
	/**
	 * Render stored `details` as one human-readable line.
	 *
	 * VALIDATES FIRST and throws on anything its schema rejects, so a row that
	 * predates a schema change fails loudly instead of rendering half a bank
	 * account. Callers holding untrusted input should go through
	 * `parseRailDetails` (see `./index.ts`) rather than catching here.
	 */
	readonly format: (details: unknown) => string;
}

/**
 * Build a registry entry from a rail's own schema and a formatter typed to that
 * schema's output.
 *
 * This is the only place the two halves meet: `format` receives PARSED details, so
 * a rail's formatter can never read a field the rail's schema does not guarantee,
 * and the erased {@link PayoutRail} the registry stores needs no cast.
 */
export function defineRail<Schema extends z.ZodType>(definition: {
	id: string;
	label: string;
	detailsSchema: Schema;
	fields: readonly RailField[];
	format: (details: z.output<Schema>) => string;
}): PayoutRail {
	return {
		id: definition.id,
		label: definition.label,
		detailsSchema: definition.detailsSchema,
		fields: definition.fields,
		format: (details) => definition.format(definition.detailsSchema.parse(details))
	};
}
