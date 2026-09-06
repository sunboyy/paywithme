// `/settings/receiving` — the owner's receiving-method editor (issue #85;
// PLAN §17.1–§17.2, §17.4, §10).
//
// Server-first and progressively enhanced, like every other screen: `load` reads
// the caller's OWN profile (`listOwn`) and every control on the page is a real
// form action. Add, edit, delete and reorder all work with JavaScript disabled;
// `use:enhance` and the delete confirmation are layered on top.
//
// ── The form is driven by the registry, never by a per-rail `if` ─────────────
// `load` sends each rail's FIELD DESCRIPTORS (`$lib/payout-rail-fields`) to the
// page, and the actions read back exactly the fields the submitted rail declares.
// Nothing here — and nothing in the component — names `th_promptpay` or any other
// rail. Adding a country is a new registry entry (ADR-0016); this route and its
// component are not touched.
//
// ── Why no superforms here (the one screen that can't use it) ────────────────
// Every other form in the app validates through ONE shared Zod schema, so
// `superValidate(request, zod4(schema))` fits. Here the schema is chosen AT
// RUNTIME by the submitted rail, and a client-side `superForm` would have to hold
// a validator per rail — which is exactly the per-rail branch this feature exists
// to avoid. So the actions read `FormData` directly and hand `(rail, details)` to
// the #84 service, which is the single gate that validates through the registry.
// Field errors come back as the RAIL SCHEMA'S OWN messages (`z.flattenError`);
// this route never paraphrases a validation rule.
//
// ── Add and edit are query-param steps on this same route ────────────────────
// `?add=<railId>` renders that rail's fields; `?edit=<methodId>` renders one
// method's. Picking a rail is therefore a plain GET form and needs no JS, and only
// ONE rail's fields are ever in the DOM — so two rails that share a field name
// (both Thai rails have `accountHolderName`) can never collide in the submission.
// The action URLs keep the param (`?/add&add=…`) so a rejected submit re-renders
// the same form instead of bouncing back to the list.
//
// A successful add/edit REDIRECTS to the bare route: the step closes, and a reload
// can't re-post it.

import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/access';
import { pathAndQuery } from '$lib/redirect';
import { RAILS, findRail, formatRailDetails } from '$lib/server/payout-rails';
import {
	create,
	listOwn,
	remove,
	reorder,
	update,
	InvalidReceivingMethodError,
	ReceivingMethodNotFoundError,
	ReceivingMethodOrderMismatchError,
	type ReceivingMethod
} from '$lib/server/receiving-methods';
import type { RailField } from '$lib/payout-rail-fields';
import type { Actions, PageServerLoad } from './$types';

/** Where a finished add/edit lands, and what "Cancel" goes back to. */
const ROUTE = '/settings/receiving';

/** One rail, as the page needs it: a label to pick and the fields to render. */
export type RailView = {
	id: string;
	label: string;
	fields: readonly RailField[];
};

/** One row of the profile, in `position` order. */
export type MethodView = {
	id: string;
	railLabel: string;
	/**
	 * The rail's own one-line rendering, or `null` when the stored `details` no
	 * longer satisfy the rail's schema (or the rail itself is gone from the
	 * registry). The formatter refuses to half-render a bank account, and the
	 * OWNER'S editor must still list such a row — otherwise the only screen that
	 * could delete it is the one hiding it.
	 */
	summary: string | null;
	isFirst: boolean;
	isLast: boolean;
};

/** The add/edit step, when one is open. */
export type EditorView = {
	/** Absent when adding — an add has no row yet. */
	methodId: string | null;
	rail: RailView;
	/** Current value per field name, `''` when unset. Always a string: forms post strings. */
	values: Record<string, string>;
};

/** What an action hands back to the page on anything other than a redirect. */
export type ActionOutcome = {
	intent: 'add' | 'edit' | 'delete' | 'move';
	/** Rail schema messages, keyed by field name — rendered against the inputs. */
	fieldErrors?: Record<string, string[] | undefined>;
	/** What the user typed, so a rejected form re-renders filled in. */
	values?: Record<string, string>;
	/** A whole-form message (never a per-field rule). */
	message?: { type: 'error' | 'success'; text: string };
};

export const load: PageServerLoad = async ({ locals, url }) => {
	// Own-profile screen: a session is required. `requireUser` THROWS the redirect,
	// so it stays outside any try/catch (the trap noted in `access.ts`).
	const user = requireUser(locals, { redirectTo: pathAndQuery(url) });

	// Deliberately NOT degraded to an empty list the way `/settings` degrades its
	// passkey read: the empty state here says "you have no receiving methods", and
	// saying that to a user who has three would invite them to add a fourth
	// duplicate. A read failure is an error page, not a lie.
	const methods = await listOwn(user.id);

	// `?edit=` wins over `?add=` — one step at a time on a phone (PLAN §10).
	const editing =
		toEditor(methods, url.searchParams.get('edit')) ?? toAdd(url.searchParams.get('add'));

	return {
		methods: methods.map((method, index) => ({
			id: method.id,
			railLabel: findRail(method.rail)?.label ?? method.rail,
			summary: safeFormat(method),
			isFirst: index === 0,
			isLast: index === methods.length - 1
		})) satisfies MethodView[],
		// The picker's options — the registry's own order (PLAN §17.2: no rail is
		// privileged, so the page never re-sorts or pre-selects one).
		rails: RAILS.map(toRailView) satisfies RailView[],
		editing
	};
};

export const actions: Actions = {
	// Add a method to the end of the profile. The rail comes from the submission
	// and is validated by the registry (an unknown key can only be a tampered post
	// — the picker offers registry entries only).
	add: async ({ request, locals, url }) => {
		const user = requireUser(locals, { redirectTo: url.pathname });

		const data = await request.formData();
		const rail = findRail(readString(data, 'rail'));
		if (!rail) {
			return fail(400, {
				intent: 'add',
				message: { type: 'error', text: 'Choose how you want to be paid.' }
			} satisfies ActionOutcome);
		}

		const values = readFields(data, rail.fields);

		try {
			await create(user.id, rail.id, values);
		} catch (e) {
			return fail(...invalidOrFailed('add', e, values, 'Could not save that. Please try again.'));
		}

		redirect(303, ROUTE);
	},

	// Replace one method's details. The RAIL IS NOT SUBMITTED: it is read from the
	// stored row (which is also the ownership check), so a form can never move a
	// row onto another rail — switching rails is a delete plus an add (#84).
	edit: async ({ request, locals, url }) => {
		const user = requireUser(locals, { redirectTo: url.pathname });

		const data = await request.formData();
		const id = readString(data, 'id');

		// Another user's id — or one that no longer exists — is a 404, undistinguished
		// (PLAN §12 "don't leak"): the two must not be tellable apart.
		const existing = (await listOwn(user.id)).find((method) => method.id === id);
		const rail = existing && findRail(existing.rail);
		if (!rail) error(404, 'Receiving method not found');

		const values = readFields(data, rail.fields);

		try {
			await update(user.id, id, values);
		} catch (e) {
			if (e instanceof ReceivingMethodNotFoundError) error(404, 'Receiving method not found');
			return fail(...invalidOrFailed('edit', e, values, 'Could not save that. Please try again.'));
		}

		redirect(303, ROUTE);
	},

	// Hard delete (#84: nothing references a receiving method). Confirmed in the UI
	// by an Alert Dialog when JS is present; the form action is the real gate.
	delete: async ({ request, locals, url }) => {
		const user = requireUser(locals, { redirectTo: url.pathname });

		const data = await request.formData();

		try {
			await remove(user.id, readString(data, 'id'));
		} catch (e) {
			if (e instanceof ReceivingMethodNotFoundError) error(404, 'Receiving method not found');
			return fail(500, {
				intent: 'delete',
				message: { type: 'error', text: 'Could not remove that. Please try again.' }
			} satisfies ActionOutcome);
		}

		return {
			intent: 'delete',
			message: { type: 'success', text: 'Receiving method removed' }
		} satisfies ActionOutcome;
	},

	// Move one method one place up or down — NOT drag-and-drop, which cannot work
	// without JS. Order is the whole preference model (PLAN §17.1: first is what
	// the settle screen shows), so this posts the FULL id order to `reorder`, which
	// rejects anything that isn't exactly the current set.
	move: async ({ request, locals, url }) => {
		const user = requireUser(locals, { redirectTo: url.pathname });

		const data = await request.formData();
		const id = readString(data, 'id');
		const direction = readString(data, 'direction');
		if (direction !== 'up' && direction !== 'down') {
			return fail(400, {
				intent: 'move',
				message: { type: 'error', text: 'Could not move that. Please try again.' }
			} satisfies ActionOutcome);
		}

		const ids = (await listOwn(user.id)).map((method) => method.id);
		const from = ids.indexOf(id);
		if (from === -1) error(404, 'Receiving method not found');

		const to = direction === 'up' ? from - 1 : from + 1;
		// Already at the end it was asked to move towards: nothing to do. The buttons
		// are disabled there, so this is a stale page or a hand-made post — neither is
		// an error worth showing.
		if (to < 0 || to >= ids.length) return { intent: 'move' } satisfies ActionOutcome;

		[ids[from], ids[to]] = [ids[to], ids[from]];

		try {
			await reorder(user.id, ids);
		} catch (e) {
			if (e instanceof ReceivingMethodOrderMismatchError) {
				// The profile changed under this page (another tab). Reloading is the
				// remedy, and `load` re-runs on the way back anyway.
				return fail(409, {
					intent: 'move',
					message: {
						type: 'error',
						text: 'Your receiving methods changed somewhere else. Reload and try again.'
					}
				} satisfies ActionOutcome);
			}
			return fail(500, {
				intent: 'move',
				message: { type: 'error', text: 'Could not move that. Please try again.' }
			} satisfies ActionOutcome);
		}

		return {
			intent: 'move',
			message: { type: 'success', text: 'Order updated' }
		} satisfies ActionOutcome;
	}
};

/** A registry entry, trimmed to what the page renders. */
function toRailView(rail: (typeof RAILS)[number]): RailView {
	return { id: rail.id, label: rail.label, fields: rail.fields };
}

/** The `?add=<railId>` step, or `null` for a missing/unknown rail. */
function toAdd(railId: string | null): EditorView | null {
	const rail = railId ? findRail(railId) : undefined;
	if (!rail) return null;
	return { methodId: null, rail: toRailView(rail), values: blankValues(rail.fields) };
}

/**
 * The `?edit=<methodId>` step, or `null`.
 *
 * `methods` is already the caller's own profile, so an id belonging to someone
 * else simply isn't in it — another user's method can't be opened, and the page
 * falls back to the list rather than announcing that the id exists.
 */
function toEditor(methods: ReceivingMethod[], methodId: string | null): EditorView | null {
	const method = methodId ? methods.find((m) => m.id === methodId) : undefined;
	const rail = method && findRail(method.rail);
	if (!method || !rail) return null;

	const stored = asRecord(method.details);
	return {
		methodId: method.id,
		rail: toRailView(rail),
		values: Object.fromEntries(
			rail.fields.map((field) => [field.name, stringify(stored[field.name])])
		)
	};
}

/** Render a stored row, or `null` if the rail refuses to render it (see `MethodView`). */
function safeFormat(method: ReceivingMethod): string | null {
	try {
		return formatRailDetails(method.rail, method.details);
	} catch {
		return null;
	}
}

/** Empty strings for every field — the add form's starting values. */
function blankValues(fields: readonly RailField[]): Record<string, string> {
	return Object.fromEntries(fields.map((field) => [field.name, '']));
}

/**
 * Read EXACTLY the fields the rail declares, and nothing else.
 *
 * This is where "driven by the registry" is enforced on the write side: a field
 * the rail doesn't declare is never read out of the submission, so a hand-made
 * post can't smuggle an extra key towards the jsonb column (the rail's schema
 * strips unknown keys as well — belt and braces).
 */
function readFields(data: FormData, fields: readonly RailField[]): Record<string, string> {
	return Object.fromEntries(fields.map((field) => [field.name, readString(data, field.name)]));
}

/** One submitted string field; a missing value (or a file) reads as `''`. */
function readString(data: FormData, name: string): string {
	const value = data.get(name);
	return typeof value === 'string' ? value : '';
}

/** `details` as a bag of values, whatever the column actually holds. */
function asRecord(details: unknown): Record<string, unknown> {
	return details && typeof details === 'object' && !Array.isArray(details)
		? (details as Record<string, unknown>)
		: {};
}

/** A stored value as an input value. Non-strings become their own text, never `undefined`. */
function stringify(value: unknown): string {
	return value === null || value === undefined ? '' : String(value);
}

/**
 * Map a service throw onto a `fail(...)` payload.
 *
 * A rejected `(rail, details)` becomes 400 + THE RAIL SCHEMA'S OWN per-field
 * messages; anything else is a generic 500 message (never the raw cause —
 * PLAN §12). Returned as a tuple so callers can `return fail(...x)`.
 */
function invalidOrFailed(
	intent: ActionOutcome['intent'],
	e: unknown,
	values: Record<string, string>,
	genericText: string
): [number, ActionOutcome] {
	if (e instanceof InvalidReceivingMethodError) {
		return [
			400,
			{
				intent,
				values,
				fieldErrors: e.error ? z.flattenError(e.error).fieldErrors : undefined,
				message: e.error
					? undefined
					: { type: 'error', text: 'That way of being paid is not available.' }
			}
		];
	}
	return [500, { intent, values, message: { type: 'error', text: genericText } }];
}
