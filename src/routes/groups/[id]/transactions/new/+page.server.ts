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
import { categoriesFor, getCategory } from '$lib/categories';
import { getCurrency, CURRENCIES, MAX_SAFE_MINOR, type CurrencyCode } from '$lib/money';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { getGroupForUser, GroupAccessError } from '$lib/server/groups';
import { listMembers } from '$lib/server/members';
import { createTransaction, TransactionValidationError } from '$lib/server/transactions';
import type { Actions, PageServerLoad } from './$types';

/**
 * A resolved §8.4 settle-via-transfer PREFILL (task 5.4). The settle page links
 * here with `?type=transfer&from=<debtorMemberId>&to=<creditorMemberId>&amount=<minor>
 * &category=transfer-debt-settlement` to seed a Transfer (payer = debtor,
 * recipient = creditor, the settlement amount, category = Debt settlement).
 *
 * The query string is UNTRUSTED — these are convenience fields the user can still
 * edit, and the server `default` action re-validates + re-resolves everything
 * anyway. So we VALIDATE every param against TRUSTED group context here and fall
 * back to the blank default on ANY problem (never throw):
 *   - `type` must be exactly `transfer` (the only prefilled type).
 *   - `from` / `to` must each be an ACTIVE member id of THIS group (the loaded
 *     allow-list), and distinct from each other.
 *   - `amount` must be a positive safe integer ≤ the schema max (minor units).
 *   - `category` must be a valid TRANSFER category id.
 * Returns `null` when any param is absent or invalid → the caller keeps its
 * normal blank spending default.
 */
function resolveTransferPrefill(
	url: URL,
	activeMemberIds: ReadonlySet<string>
): {
	from: string;
	to: string;
	amount: number;
	categoryId: string;
} | null {
	const type = url.searchParams.get('type');
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const amountRaw = url.searchParams.get('amount');
	const categoryId = url.searchParams.get('category');

	// Only the Transfer prefill is supported; anything else → blank default.
	if (type !== 'transfer') {
		return null;
	}

	// from / to: both required, both active members of THIS group, and distinct
	// (a self-transfer makes no sense and the resolver would reject it anyway).
	if (!from || !to || from === to) {
		return null;
	}
	if (!activeMemberIds.has(from) || !activeMemberIds.has(to)) {
		return null;
	}

	// category: a valid TRANSFER category id (applies_to === 'transfer').
	if (!categoryId) {
		return null;
	}
	const category = getCategory(categoryId);
	if (category === undefined || category.appliesTo !== 'transfer') {
		return null;
	}

	// amount: a positive safe integer (minor units) within the schema's range.
	// Reject non-numeric / float / out-of-range / non-positive values.
	if (!amountRaw || !/^\d+$/.test(amountRaw)) {
		return null;
	}
	const amount = Number(amountRaw);
	if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_SAFE_MINOR) {
		return null;
	}

	return { from, to, amount, categoryId };
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
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

	// §8.4 settle-via-transfer prefill (task 5.4): if the settle page linked here
	// with valid `?type=transfer&from&to&amount&category` params (validated against
	// the TRUSTED active-member allow-list + transfer categories), seed a Transfer
	// (payer = debtor, single beneficiary = creditor, the amount, Debt settlement).
	// On ANY invalid/absent param this is null → the normal blank spending default
	// below is used unchanged (task 4.7's behavior is preserved).
	const prefill = resolveTransferPrefill(url, new Set(activeMembers.map((m) => m.id)));

	// Seed a default form: spending / equal split, payer = the viewer's member,
	// beneficiaries = all active members. amountTotal 0 (the user fills it in).
	// When a valid Transfer prefill is present, seed THAT instead (the settlement
	// amount is already in minor units — no float parsing — and equals the
	// settlement total since the entry currency is the settlement currency).
	const defaults = prefill
		? {
				type: 'transfer' as const,
				title: '',
				categoryId: prefill.categoryId,
				amountTotal: prefill.amount,
				currency: settlementCurrency,
				exchangeRate: '1',
				amountTotalSettlement: prefill.amount,
				splitMode: 'equal' as const,
				// payer = debtor pays the whole amount; recipient = creditor is the lone
				// (equal-split) beneficiary, so they receive all of it.
				payers: [{ memberId: prefill.from, amountPaid: prefill.amount }],
				beneficiaries: [{ memberId: prefill.to }],
				items: [],
				charges: []
			}
		: {
				type: 'spending' as const,
				title: '',
				categoryId: categoriesFor('spending')[0]?.id ?? '',
				amountTotal: 0,
				currency: settlementCurrency,
				exchangeRate: '1',
				amountTotalSettlement: 0,
				splitMode: 'equal' as const,
				payers: viewerMember ? [{ memberId: viewerMember.id, amountPaid: 0 }] : [],
				beneficiaries: activeMembers.map((m) => ({ memberId: m.id })),
				items: [],
				charges: []
			};

	const form = await superValidate(zod4(schema), { defaults });

	return {
		form,
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		// The full supported-currency list for the FX picker (§7.6). The form defaults
		// the picker to the group settlement currency; choosing a different one reveals
		// the rate / settlement-total entry.
		currencies: CURRENCIES.map((c) => ({
			code: c.code,
			symbol: c.symbol,
			exponent: c.exponent,
			name: c.name
		})),
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
