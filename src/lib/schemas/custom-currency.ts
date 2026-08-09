// Shared custom-currency Zod schemas (CLAUDE.md: "shared Zod schemas in
// lib/schemas/"). The input contract for a GROUP-DEFINED currency (PLAN §7.5.2;
// ADR-0014) — the create / edit forms (#62) and the service
// (`lib/server/currencies.ts`) validate through exactly these, so the rules and
// their messages can never drift between the client form and the server boundary.
//
// ── What is NOT here (deliberately) ───────────────────────────────────────────
//   - `code`. A custom row's primary key is GENERATED, globally unique and opaque
//     (`cur_<uuid>`, see `lib/server/db/currencies-schema.ts`). It is never typed,
//     never shown and NEVER ACCEPTED FROM A CALLER, so there is no field for it:
//     the service mints it. What the member types is `displayCode` (CONTEXT.md
//     "Display code").
//   - `groupId` / `createdBy`. Server-derived from the authenticated session, never
//     submitted.
//   - anything that could reach `groups.settlement_currency`. A custom currency is
//     an ENTRY currency and nothing else (ADR-0014 decision 1) — `currencyCodeSchema`
//     (`./currency.ts`) keeps guarding that column, and this file is not part of
//     that path.
//
// `displayCode`, `name` and `symbol` are MEMBER-AUTHORED TEXT (CONTEXT.md): these
// rules bound their shape and size, they do NOT make the text trusted. Wrapping
// where it reaches an agent is ADR-0003 / ADR-0004 and belongs to the read
// surfaces (#64).

import { z } from 'zod';

/**
 * The user-visible code (`BEER`), uppercased and trimmed — the only currency code
 * that ever appears in an interface (CONTEXT.md "Display code").
 *
 * Rules, in the order they apply:
 *   - `trim()` then `toUpperCase()` — PLAN §7.5.2 pins "short, uppercased". Case is
 *     normalized rather than rejected, so `beer` and `BEER` are the SAME code and
 *     the per-group uniqueness check can't be dodged by case.
 *   - non-empty AFTER trimming (a whitespace-only code is rejected, not stored).
 *   - `DISPLAY_CODE_MAX_LENGTH` chars — "short" is what lets it sit next to an
 *     amount like an ISO code does.
 *   - no whitespace ANYWHERE. Already trimmed, so this only rules out *interior*
 *     spaces: a display code is a token (`BEER`), not a phrase — that's what `name`
 *     is for. Deliberately NOT restricted to `[A-Z0-9]`: this app's primary audience
 *     is Thai and a non-Latin script has no uppercase form, so an ASCII-only rule
 *     would reject a perfectly good code for no gain.
 *
 * Note the uppercasing also makes a display code STRUCTURALLY UNABLE to collide
 * with an opaque `code`: `CUSTOM_CURRENCY_CODE_PREFIX` is the lowercase `cur_`, so
 * even a member who types `cur_x` stores `CUR_X`.
 */
export const DISPLAY_CODE_MAX_LENGTH = 8;

const displayCodeField = z
	.string()
	.trim()
	.toUpperCase()
	.min(1, { message: 'A code is required' })
	.max(DISPLAY_CODE_MAX_LENGTH, {
		message: `Code must be ${DISPLAY_CODE_MAX_LENGTH} characters or fewer`
	})
	.regex(/^\S+$/, { message: 'Code cannot contain spaces' });

/** The currency's human-readable name ('Bottle of beer'). Required, trimmed, bounded. */
const nameField = z
	.string()
	.trim()
	.min(1, { message: 'A name is required' })
	.max(60, { message: 'Name must be 60 characters or fewer' });

/**
 * The display symbol ('🍺', 'NZ$'). Required, trimmed, and short — it is PREFIXED
 * to an amount. A custom currency's symbol is always disambiguated at format time
 * (ADR-0014 decision 4), so it need not be unique here.
 */
const symbolField = z
	.string()
	.trim()
	.min(1, { message: 'A symbol is required' })
	.max(8, { message: 'Symbol must be 8 characters or fewer' });

/**
 * Minor-unit exponent, 0–3 (PLAN §7.5.2 / §7.5). Integer only — it is the power of
 * ten between major and minor units, and all money math is integer minor units.
 * `0` for a countable unit ('3 BEER'), `2` for a money-like one.
 *
 * This is the field the immutability lock exists for: once a transaction is stored
 * against the row, changing it silently reinterprets every amount already recorded
 * (the §6.4 hazard). The lock lives in the service — it needs the DB — not here.
 */
const exponentField = z
	.number({ message: 'A number of decimal places is required' })
	.int({ message: 'Decimal places must be a whole number' })
	.min(0, { message: 'Decimal places must be between 0 and 3' })
	.max(3, { message: 'Decimal places must be between 0 and 3' });

/**
 * Create-a-custom-currency input (PLAN §7.5.2). All four fields required; the
 * opaque `code`, the owning group and the author are server-derived (see the
 * module header).
 */
export const createCustomCurrencySchema = z.object({
	displayCode: displayCodeField,
	name: nameField,
	symbol: symbolField,
	exponent: exponentField
});

/** Inferred, normalized create input — shared by the form and the service. */
export type CreateCustomCurrencyInput = z.infer<typeof createCustomCurrencySchema>;

/**
 * Edit-a-custom-currency input. Every field is OPTIONAL: after the first
 * referencing transaction only `name` and `symbol` may move (ADR-0014 decision 5),
 * so a partial edit must be expressible without re-submitting the frozen fields.
 *
 * A submitted field that equals the stored value is NOT a change — the service
 * compares before it decides anything is frozen, so re-posting a whole form
 * (`displayCode` and `exponent` included, unchanged) stays legal on a locked row.
 *
 * The refine below rejects an edit whose fields are ALL ABSENT — a request that
 * names nothing to change. It cannot go further: whether the submitted VALUES
 * differ from the stored ones is a question only the row can answer, and this is a
 * pure schema with no database. So "an edit that moves nothing writes no
 * `audit_log` row" (PLAN §12.1 — the trail must not claim an edit that didn't
 * happen) is enforced by `updateCustomCurrency`, which short-circuits once it has
 * compared against the loaded row. Two layers, one guarantee.
 */
export const updateCustomCurrencySchema = createCustomCurrencySchema
	.partial()
	.refine((v) => Object.values(v).some((field) => field !== undefined), {
		message: 'Nothing to update'
	});

/** Inferred, normalized edit input — shared by the form and the service. */
export type UpdateCustomCurrencyInput = z.infer<typeof updateCustomCurrencySchema>;

/**
 * The opaque row identifier a FORM has to carry to name which currency it acts on
 * (#62). It is the one place the opaque `code` legitimately appears in a request:
 * a hidden field the server rendered, never something a member types or reads (see
 * the module header — it is still never *displayed*).
 *
 * Shape only. Whether the code names a row THIS GROUP owns is a database question,
 * answered by `getGroupCurrencyForUpdate` in the service (a seeded row or another
 * group's row is indistinguishable from a typo: `CurrencyNotFoundError` → 404).
 */
const opaqueCodeField = z.string().trim().min(1, { message: 'A currency is required' });

/**
 * The manage-currencies screen's DELETE form (#62): nothing but the target row.
 * Deliberately its own schema rather than a reuse of {@link editCustomCurrencySchema}
 * — Superforms derives a form's default `id` from its JSON schema, so the three
 * forms on that page must be structurally distinct for their action results to
 * route back to the right client instance.
 */
export const customCurrencyRefSchema = z.object({ code: opaqueCodeField });

/** Inferred delete/target input. */
export type CustomCurrencyRefInput = z.infer<typeof customCurrencyRefSchema>;

/**
 * The manage-currencies screen's EDIT form (#62): the target row plus the full set
 * of fields, because an HTML form posts everything it renders.
 *
 * Every field is REQUIRED here even though {@link updateCustomCurrencySchema} makes
 * them optional, and the two do not disagree. A form always submits all four — a
 * frozen field is rendered read-only (or as a hidden input carrying the stored
 * value), which still POSTS. The service compares each submitted value against the
 * stored row and treats "same value" as "not a change", so re-posting a frozen
 * `displayCode` / `exponent` unchanged stays legal on a referenced row, and an edit
 * that moves nothing writes no `audit_log` row. The partial schema exists for
 * non-form callers; this one is the shape of the HTML form.
 */
export const editCustomCurrencySchema = createCustomCurrencySchema.extend({
	code: opaqueCodeField
});

/** Inferred edit-form input — the target row plus all four fields. */
export type EditCustomCurrencyInput = z.infer<typeof editCustomCurrencySchema>;
