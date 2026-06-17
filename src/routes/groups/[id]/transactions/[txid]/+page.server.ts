// `/groups/[id]/transactions/[txid]` — view / edit / soft-delete + restore a single
// transaction (task 4.11; PLAN §7.1, §7.2, §7.6, §9, §10, §12.1).
//
// Server-first + progressively enhanced. `load` access-checks + loads the detail
// (reconstructed `TransactionInput`) and seeds an edit `superValidate` from it +
// the form's supporting data (active members, type-filtered categories, the
// supported currencies). The three actions are REAL form actions (work without JS):
//   - `edit`    → re-validate with the shared schema → `updateTransaction` → refresh.
//   - `delete`  → `softDeleteTransaction` → redirect to the list (guarded by an
//                 Alert Dialog on the client; the underlying form still works no-JS).
//   - `restore` → `restoreTransaction` → refresh (non-destructive).
// Every mutation is audited in the service's single `db.transaction` (§12.1). The
// service re-validates + re-resolves server-side and is the source of truth — the
// route never trusts client-resolved/settlement values. 404 on no-access/not-found
// (existence never leaked, §12).

import { error, fail, redirect } from '@sveltejs/kit';
import { setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { buildTransactionSchema } from '$lib/schemas/transaction';
import { categoriesFor } from '$lib/categories';
import { getCurrency, CURRENCIES, type CurrencyCode } from '$lib/money';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { getGroupForUser, GroupAccessError } from '$lib/server/groups';
import { listMembers } from '$lib/server/members';
import {
	getTransactionDetail,
	updateTransaction,
	softDeleteTransaction,
	restoreTransaction,
	TransactionValidationError,
	TransactionNotFoundError,
	TransactionDeletedError
} from '$lib/server/transactions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	// Centralized guard (task 3.8): anonymous → redirect; no-access/not-found → 404.
	// THROWS control flow — keep outside any try/catch.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	const settlementCurrency = group.settlementCurrency as CurrencyCode;
	const currency = getCurrency(settlementCurrency);

	let detail;
	try {
		detail = await getTransactionDetail({
			userId: user.id,
			groupId: params.id,
			txnId: params.txid
		});
	} catch (e) {
		// A txn in another group / a bogus id → 404 (existence never leaked, §12).
		if (e instanceof TransactionNotFoundError || e instanceof GroupAccessError) {
			error(404, 'Transaction not found');
		}
		throw e;
	}

	const members = await listMembers({ userId: user.id, groupId: params.id });
	// Active members are selectable in the edit form; but a member already ON this txn
	// (possibly since deactivated) must stay seedable so the reconstructed input still
	// validates against the allow-list. Union the two sets.
	const onTxnIds = new Set<string>([
		...detail.input.payers.map((p) => p.memberId),
		...detail.input.beneficiaries.map((b) => b.memberId),
		...detail.input.items.flatMap((i) => i.beneficiaries.map((b) => b.memberId))
	]);
	const formMembers = members
		.filter((m) => m.deactivatedAt === null || onTxnIds.has(m.id))
		.map((m) => ({ id: m.id, displayName: m.displayName, isLinked: m.isLinked }));

	// A name lookup for the read-only view (payers / shares show member display names).
	const memberNames = Object.fromEntries(members.map((m) => [m.id, m.displayName]));

	// Seed the edit form from the RECONSTRUCTED input (§7.2/§7.6 faithful re-edit).
	const schema = buildTransactionSchema({
		settlementCurrency,
		memberIds: formMembers.map((m) => m.id)
	});
	const form = await superValidate(detail.input, zod4(schema), {
		// Don't surface validation errors on first paint — it's a faithful round-trip.
		errors: false
	});

	return {
		form,
		detail,
		memberNames,
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		currencies: CURRENCIES.map((c) => ({
			code: c.code,
			symbol: c.symbol,
			exponent: c.exponent,
			name: c.name
		})),
		members: formMembers,
		categories: {
			spending: categoriesFor('spending').map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
			transfer: categoriesFor('transfer').map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
		}
	};
};

export const actions: Actions = {
	// ── edit ────────────────────────────────────────────────────────────────────
	edit: async ({ request, params, locals }) => {
		const user = requireUser(locals);

		// Re-load the group for its settlement currency + member allow-list (trusted
		// group context, NOT the payload).
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
			await updateTransaction({
				userId: user.id,
				groupId: params.id,
				txnId: params.txid,
				input: form.data,
				actorUserId: user.id,
				settlementCurrency
			});
		} catch (e) {
			if (e instanceof GroupAccessError || e instanceof TransactionNotFoundError) {
				error(404, 'Transaction not found');
			}
			if (e instanceof TransactionDeletedError) {
				// Editing a soft-deleted txn is refused — surface a form-level message
				// (restore first), NOT a 500.
				return setError(form, '', e.message);
			}
			if (e instanceof TransactionValidationError) {
				for (const issue of e.issues) {
					setError(form, issue.path.join('.') as never, issue.message);
				}
				return fail(400, { form });
			}
			return fail(500, { form });
		}

		// Success → refresh the detail page (now showing the edited values).
		redirect(303, `/groups/${params.id}/transactions/${params.txid}`);
	},

	// ── delete (soft) ─────────────────────────────────────────────────────────────
	delete: async ({ params, locals }) => {
		const user = requireUser(locals);
		try {
			await softDeleteTransaction({
				userId: user.id,
				groupId: params.id,
				txnId: params.txid,
				actorUserId: user.id
			});
		} catch (e) {
			if (e instanceof GroupAccessError || e instanceof TransactionNotFoundError) {
				error(404, 'Transaction not found');
			}
			throw e;
		}
		// Soft-delete → back to the list (the deleted txn is hidden there, §9).
		redirect(303, `/groups/${params.id}/transactions`);
	},

	// ── restore ─────────────────────────────────────────────────────────────────
	restore: async ({ params, locals }) => {
		const user = requireUser(locals);
		try {
			await restoreTransaction({
				userId: user.id,
				groupId: params.id,
				txnId: params.txid,
				actorUserId: user.id
			});
		} catch (e) {
			if (e instanceof GroupAccessError || e instanceof TransactionNotFoundError) {
				error(404, 'Transaction not found');
			}
			throw e;
		}
		// Restore → refresh the detail page (now live + editable again).
		redirect(303, `/groups/${params.id}/transactions/${params.txid}`);
	}
};
