// What a rail's form fields LOOK LIKE — the serializable half of a registry entry
// (issue #85; PLAN §17.2, §17.4; ADR-0016).
//
// The rail registry itself lives in `$lib/server/payout-rails/` and can never be
// imported by a component (it is server-only, and its `detailsSchema` / `format`
// are not serializable anyway). So each rail also declares a FIELD DESCRIPTOR
// LIST, made of nothing but data: `load` hands it to the page, and the page walks
// it to render the form.
//
// THIS IS WHAT KEEPS `/settings/receiving` FREE OF PER-RAIL CONDITIONALS. The
// editor branches on a field's CONTROL (text / select / textarea) — three shapes
// of HTML input — and never on which rail it belongs to. Adding a country is a new
// registry entry with its own descriptors; the component is not touched.
//
// The types live here, outside `lib/server/`, precisely so a `.svelte` file may
// import them for typing without reaching into server-only code.
//
// EVERY CONTROL PRODUCES A STRING. A form submits strings, so a rail whose schema
// wants something else must coerce in its OWN schema (`z.coerce…`) — the editor
// does not guess types on a rail's behalf.

/** One choice in a `select` field. `value` is what the rail's schema will parse. */
export interface RailFieldOption {
	readonly value: string;
	readonly label: string;
}

/** The three input shapes a rail may ask for. */
export type RailFieldControl = 'text' | 'select' | 'textarea';

/**
 * What one field means to the PAYER who is about to make the transfer (issue #86).
 *
 * The owner's editor ignores this; the settle screen and member detail read it, and
 * it is what keeps THOSE surfaces free of per-rail conditionals too:
 *
 *   - `'copy'` — the value a payer types into their banking app (an account
 *     number, a PromptPay proxy). It gets the copy affordance; nothing else does,
 *     because copying "KBank · 1234567890 · Somchai Jaidee" into an account-number
 *     box helps nobody.
 *   - `'name-check'` — the account holder name the payer must compare against what
 *     their banking app displays before confirming (PLAN §17.2). This is the
 *     feature's only defence against a valid-but-wrong account number.
 *
 * At most one role per field, and a rail may declare neither (`other` has no
 * holder name to check — PLAN §17.2 requires one on every rail except that one).
 */
export type RailFieldPayerRole = 'copy' | 'name-check';

/**
 * One field of a rail's `details`, described well enough to render.
 *
 * `name` MUST be a key of the rail's own `detailsSchema` — that is how a submitted
 * value reaches validation and how a stored value is read back for editing. A unit
 * test in `payout-rails/index.test.ts` asserts the two lists match, so a renamed
 * schema key can't leave a field silently unwritten.
 *
 * There is deliberately no `required`, `pattern` or `min`/`max` here beyond
 * `maxLength`: validation belongs to the rail's Zod schema, and its messages come
 * back from the server (PLAN §17.2). `maxLength` is the one exception — it stops
 * a value being typed that could never be stored, and the cap is the SCHEMA'S,
 * passed through rather than restated.
 */
export interface RailField {
	readonly name: string;
	readonly label: string;
	readonly control: RailFieldControl;
	/** Required for `control: 'select'`, absent otherwise. */
	readonly options?: readonly RailFieldOption[];
	readonly placeholder?: string;
	/** One short line under the input — guidance, never a validation rule. */
	readonly hint?: string;
	/** The schema's own length cap, passed through to the input. */
	readonly maxLength?: number;
	/** Mobile keyboard hint. `numeric` for the digits-only fields. */
	readonly inputMode?: 'text' | 'numeric';
	/**
	 * What this field is to a payer reading the method (issue #86). Absent for a
	 * field that is neither the value they copy nor the name they check.
	 */
	readonly payerRole?: RailFieldPayerRole;
}
