// `/groups/[id]/transactions/new` — add a transaction (task 4.7; PLAN §7.1, §7.2,
// §7.3, §10).
//
// Server-first + progressively enhanced: `load` seeds the form (active members,
// the type-filtered categories, the group's settlement currency) + a
// `superValidate` from the SHARED `buildTransactionSchema`; the `default` action
// re-validates with the same schema and delegates to `createTransaction` (which
// re-validates + re-resolves server-side — never trusts the client). The <form>
// posts to a real action and works without JS; superforms `enhance` upgrades it.
//
// SCOPE (4.7 + 4.8): spending & transfer with split_mode ∈ {equal, amount, share,
// itemized} in the group settlement currency. Itemized (4.8) submits non-empty
// `items` (Spending only); the route just re-validates + delegates — the service
// resolves + persists. Charges (4.9), FX (4.10), and the view/edit page (4.11) are
// later tasks. The form still submits empty `charges`, `exchangeRate: '1'`, and
// `amountTotalSettlement == amountTotal`.

import { error, fail, redirect } from '@sveltejs/kit';
import { setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { buildTransactionSchema } from '$lib/schemas/transaction';
import { categoriesFor } from '$lib/categories';
import { getCurrency, type CurrencyCode } from '$lib/money';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { getGroupForUser, GroupAccessError } from '$lib/server/groups';
import { listMembers } from '$lib/server/members';
import { createTransaction, TransactionValidationError } from '$lib/server/transactions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	// Centralized guard (task 3.8): anonymous → redirect; no-access/not-found →
	// 404. Returns the already-loaded group so we don't re-query. THROWS control
	// flow, so it stays outside any try/catch.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	const settlementCurrency = group.settlementCurrency as CurrencyCode;
	const currency = getCurrency(settlementCurrency);

	const members = await listMembers({ userId: user.id, groupId: params.id });
	// Only ACTIVE members are selectable when creating a new transaction (PLAN §6.3
	// — deactivated members stay only on existing txns, not relevant to create).
	const activeMembers = members
		.filter((m) => m.deactivatedAt === null)
		.map((m) => ({ id: m.id, displayName: m.displayName, isLinked: m.isLinked }));

	// The acting user's own member slot — the sensible default payer (PLAN §10).
	const viewerMember = members.find((m) => m.userId === user.id);

	// Build the shared schema from the group's settlement currency + active member
	// ids (the single validation source of truth; client derives its superForm from
	// the same factory).
	const schema = buildTransactionSchema({
		settlementCurrency,
		memberIds: activeMembers.map((m) => m.id)
	});

	// Seed a default form: spending / equal split, payer = the viewer's member,
	// beneficiaries = all active members. amountTotal 0 (the user fills it in).
	const form = await superValidate(zod4(schema), {
		defaults: {
			type: 'spending',
			title: '',
			categoryId: categoriesFor('spending')[0]?.id ?? '',
			amountTotal: 0,
			currency: settlementCurrency,
			exchangeRate: '1',
			amountTotalSettlement: 0,
			splitMode: 'equal',
			payers: viewerMember ? [{ memberId: viewerMember.id, amountPaid: 0 }] : [],
			beneficiaries: activeMembers.map((m) => ({ memberId: m.id })),
			items: [],
			charges: []
		}
	});

	return {
		form,
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		members: activeMembers,
		viewerMemberId: viewerMember?.id ?? null,
		// Both category sets so the client can swap the picker when the type toggles.
		categories: {
			spending: categoriesFor('spending').map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
			transfer: categoriesFor('transfer').map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
		}
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		// Guard the mutation too — never trust that `load` ran. `requireUser` THROWS
		// the redirect; keep it above the validate/try below.
		const user = requireUser(locals);

		// Re-load the group for its settlement currency + member allow-list so the
		// schema is rebuilt server-side from trusted group context (NOT the payload).
		const group = await getGroupForUser(user.id, params.id);
		if (!group) {
			error(404, 'Group not found');
		}
		const settlementCurrency = group.settlementCurrency as CurrencyCode;

		const activeMembers = (await listMembers({ userId: user.id, groupId: params.id })).filter(
			(m) => m.deactivatedAt === null
		);
		const schema = buildTransactionSchema({
			settlementCurrency,
			memberIds: activeMembers.map((m) => m.id)
		});

		const form = await superValidate(request, zod4(schema));
		if (!form.valid) {
			// Invalid input → 400 form failure (errors render inline). Never a 500.
			return fail(400, { form });
		}

		try {
			await createTransaction({
				userId: user.id,
				groupId: params.id,
				input: form.data,
				settlementCurrency
			});
		} catch (e) {
			if (e instanceof GroupAccessError) {
				error(404, 'Group not found');
			}
			if (e instanceof TransactionValidationError) {
				// The service re-validated and rejected something the client schema let
				// through (e.g. an out-of-scope itemized/charge/FX payload, or a category
				// missing from the seed). Surface as a form failure, NOT a 500.
				for (const issue of e.issues) {
					setError(form, issue.path.join('.') as never, issue.message);
				}
				return fail(400, { form });
			}
			// Generic failure — never leak the raw cause (PLAN §12).
			return fail(500, { form });
		}

		// Success → go to the list (the per-transaction view page is task 4.11; until
		// then a link there would 404, so land on the list which already exists).
		// `redirect()` THROWS; keep it outside the try/catch above.
		redirect(303, `/groups/${params.id}/transactions`);
	}
};
