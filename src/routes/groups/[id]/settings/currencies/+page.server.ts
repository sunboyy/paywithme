// `/groups/[id]/settings/currencies` — manage a group's CUSTOM currencies
// (issue #62; PLAN §7.5.2, §10; ADR-0014).
//
// Server-first + progressively enhanced, like every other group screen: `load`
// access-checks, reads the group's own currency rows (with "is it already
// referenced?" so the screen can render the frozen fields read-only), and seeds
// three forms; the actions validate through the SHARED schemas
// (`$lib/schemas/custom-currency`) and delegate to the #61 service. Every control
// is a real form action, so the screen works with JS disabled.
//
// ── Why three separate schemas / forms ────────────────────────────────────────
// Superforms derives a form's default `id` from its JSON schema, and the client
// routes an action result to the instance whose id matches. `create` (4 fields),
// `edit` (5, incl. the opaque `code`) and `delete` (1) are structurally distinct,
// so each result lands on the right form with no hand-assigned ids.
//
// ── Error mapping (the #61 error model → this screen) ─────────────────────────
// The service's four errors are all things a user can legitimately hit here, so
// none of them may reach the user as a 500 or a crash:
//   DuplicateDisplayCodeError → a field error on `displayCode` (the message
//     already distinguishes a seeded clash from one of the group's own — PLAN
//     §7.5.2 "must not shadow one of the seeded codes").
//   CurrencyImmutableError    → a field error on EACH refused field, so the form
//     marks exactly what froze rather than failing opaquely (ADR-0014 decision 5).
//     Reachable despite the read-only rendering: `load`'s reference flag is
//     advisory (see `currency-usage.ts`) and a no-JS client can post anything.
//   CurrencyInUseError        → a form-level message on the delete form.
//   CurrencyNotFoundError / GroupAccessError → 404, undistinguished (PLAN §12).

import { error, fail } from '@sveltejs/kit';
import { message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import {
	createCustomCurrencySchema,
	customCurrencyRefSchema,
	editCustomCurrencySchema
} from '$lib/schemas/custom-currency';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { GroupAccessError } from '$lib/server/groups';
import {
	createCustomCurrency,
	deleteCustomCurrency,
	updateCustomCurrency,
	CurrencyImmutableError,
	CurrencyInUseError,
	CurrencyNotFoundError,
	DuplicateDisplayCodeError
} from '$lib/server/currencies';
import { listCustomCurrenciesWithUsage } from '$lib/server/currency-usage';
import { getCurrency } from '$lib/money';
import type { Actions, PageServerLoad } from './$types';

/** The group is gone / never visible to this user, or the row isn't theirs → 404. */
function isNotFoundError(e: unknown): boolean {
	return e instanceof GroupAccessError || e instanceof CurrencyNotFoundError;
}

/** Default decimal places for a new currency — money-like, the common case. */
const DEFAULT_EXPONENT = 2;

export const load: PageServerLoad = async ({ params, locals }) => {
	// Centralized guard: anonymous → `/login`, no access / soft-deleted → 404
	// (PLAN §12). THROWS control flow, so it stays outside the try/catch below.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	// Degrade gracefully (as the members screen does): a transient list failure
	// renders an empty list rather than 500-ing the page. A real access failure
	// here would be a race — re-surface it as 404.
	let currencies: Awaited<ReturnType<typeof listCustomCurrenciesWithUsage>>;
	try {
		currencies = await listCustomCurrenciesWithUsage({ userId: user.id, groupId: params.id });
	} catch (e) {
		if (isNotFoundError(e)) {
			error(404, 'Group not found');
		}
		currencies = [];
	}

	// The settlement currency, named in full, for the entry-only notice. It is one
	// of the seeded 29 by construction (ADR-0014 decision 1), but fall back to the
	// bare code rather than crashing the page if the column ever holds something else.
	const settlement = getCurrency(group.settlementCurrency);

	return {
		group: { id: group.id, name: group.name },
		settlement: {
			displayCode: group.settlementCurrency,
			name: settlement?.name ?? group.settlementCurrency,
			symbol: settlement?.symbol ?? ''
		},
		// Only the fields the screen renders — never anything the row carries that a
		// member has no business seeing. `code` IS sent: the forms need the opaque id
		// as a hidden field to say which row they act on. It is never displayed
		// (CONTEXT.md "Display code").
		currencies: currencies.map((c) => ({
			code: c.code,
			displayCode: c.displayCode,
			name: c.name,
			symbol: c.symbol,
			exponent: c.exponent,
			isReferenced: c.isReferenced
		})),
		createForm: await superValidate(
			{ exponent: DEFAULT_EXPONENT },
			zod4(createCustomCurrencySchema),
			{
				errors: false
			}
		),
		editForm: await superValidate(zod4(editCustomCurrencySchema)),
		deleteForm: await superValidate(zod4(customCurrencyRefSchema))
	};
};

export const actions: Actions = {
	create: async ({ request, params, locals }) => {
		// Guard the mutation too — never trust that `load` ran. The service re-asserts
		// group access (→ 404) as defense in depth.
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(createCustomCurrencySchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await createCustomCurrency({
				userId: user.id,
				groupId: params.id,
				input: form.data
			});
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Group not found');
			}
			if (e instanceof DuplicateDisplayCodeError) {
				// Against the FIELD the user can actually fix (PLAN §7.5.2). The message
				// already says whether it clashed with a seeded code or their own.
				return setError(form, 'displayCode', e.message, { status: 400 });
			}
			return message(
				form,
				{ type: 'error', text: 'Could not add that currency. Please try again.' },
				{ status: 500 }
			);
		}

		// `load` re-runs after the action, so the new currency appears in the list.
		return message(form, { type: 'success', text: 'Currency added' });
	},

	edit: async ({ request, params, locals }) => {
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(editCustomCurrencySchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		const { code, ...input } = form.data;

		try {
			// All four fields are submitted; the service decides which actually MOVED,
			// so re-posting a frozen field unchanged is not an edit of it (and an edit
			// that moves nothing writes no audit row).
			await updateCustomCurrency({ userId: user.id, groupId: params.id, code, input });
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Currency not found');
			}
			if (e instanceof DuplicateDisplayCodeError) {
				return setError(form, 'displayCode', e.message, { status: 400 });
			}
			if (e instanceof CurrencyImmutableError) {
				// Mark EXACTLY the refused fields — the screen renders them read-only, so
				// reaching here means the value changed under the user (or JS was off and
				// the field was edited anyway). Either way the reason belongs on the field.
				for (const field of e.fields) {
					setError(form, field, e.message);
				}
				return fail(400, { form });
			}
			return message(
				form,
				{ type: 'error', text: 'Could not save that currency. Please try again.' },
				{ status: 500 }
			);
		}

		return message(form, { type: 'success', text: 'Currency saved' });
	},

	delete: async ({ request, params, locals }) => {
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(customCurrencyRefSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await deleteCustomCurrency({ userId: user.id, groupId: params.id, code: form.data.code });
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Currency not found');
			}
			if (e instanceof CurrencyInUseError) {
				// Not a field the user can correct — it's a state of the ledger. Say it
				// plainly on the form instead (PLAN §7.5.2: delete only while unreferenced).
				return message(form, { type: 'error', text: e.message }, { status: 400 });
			}
			return message(
				form,
				{ type: 'error', text: 'Could not delete that currency. Please try again.' },
				{ status: 500 }
			);
		}

		return message(form, { type: 'success', text: 'Currency deleted' });
	}
};
