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
// The entry-currency set is GROUP-SCOPED (#63; PLAN §7.5.2): `load` and the action
// both read `listCurrenciesForGroup` — the seeded 29 plus this group's own custom
// rows — and pass it to the shared schema, so the picker and the validator can
// never disagree about what may be recorded. The group's SETTLEMENT currency stays
// seeded-only (ADR-0014 decision 1).
//
// RECORDING A CAPTURE (issue #51; PLAN §7.7 "Resolving"): "Record it" on the "Not
// recorded yet" tray opens this page with `?capture=<id>`. `load` re-reads that row
// and PREFILLS the note as the title, the amount + currency, and `captured_for` as
// the editable `created_at` day (§7.1) — everything else is entered normally,
// because a Capture carries nothing else (ADR-0012). The save then goes through
// `recordCaptureAsTransaction`, which stamps the Capture inside the SAME DB
// transaction as the insert (§12.1). The prefill is a starting point, not a trusted
// payload: the §7.4 validation below runs in full either way.
//
// SCOPE (4.7 + 4.8): spending & transfer with split_mode ∈ {equal, amount, share,
// itemized} in the group settlement currency. Itemized (4.8) submits non-empty
// `items` (Spending only); the route just re-validates + delegates — the service
// resolves + persists. Charges (4.9), FX (4.10), and the view/edit page (4.11) are
// later tasks. The form still submits empty `charges`, `exchangeRate: '1'`, and
// `amountTotalSettlement == amountTotal`.

import { error, fail, redirect } from '@sveltejs/kit';
import { message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { buildTransactionSchema } from '$lib/schemas/transaction';
import { defaultCategoryFor, getCategory } from '$lib/categories';
import { getCurrency, MAX_SAFE_MINOR, type SeededCurrencyCode } from '$lib/money';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { pathAndQuery } from '$lib/redirect';
import { GroupAccessError } from '$lib/server/groups';
import { listMembers } from '$lib/server/members';
import {
	loadEntryCurrencies,
	loadTransactionWriteContext,
	toCategoryOptions,
	toCurrencyOptions,
	toSettlementCurrencyView
} from '$lib/server/transaction-page';
import { createTransaction, TransactionValidationError } from '$lib/server/transactions';
import {
	CaptureNotFoundError,
	CaptureNotOpenError,
	findOpenCapture,
	recordCaptureAsTransaction
} from '$lib/server/captures';
import type { GroupCurrency } from '$lib/server/currencies';
import type { Actions, PageServerLoad } from './$types';

/**
 * The `?capture=<id>` prefill — "Record it" on the "Not recorded yet" tray (issue
 * #51; PLAN §7.7 "Resolving"), which opens this page seeded from a Capture:
 * `note` → title, `amount_minor` + `currency` → the amount, `captured_for` → the
 * editable real-world date (§7.1 — the Capture's own column keeps that name, the
 * transaction's is `created_at`).
 *
 * EVERYTHING ELSE IS ENTERED NORMALLY. A Capture holds no payers, beneficiaries,
 * split mode or rate (ADR-0012), so there is nothing else to seed — and the seeded
 * fields are all still editable. Nothing here is trusted: the row is re-read from
 * the DB by id (the URL carries only the pointer), and the save re-validates the
 * whole payload through §7.4 like any other.
 */
type CapturePrefill = {
	id: string;
	/** The note, as the transaction TITLE (both fields cap at 200 chars). */
	title: string;
	/** `captured_for` → the transaction's editable `created_at` day (§7.1). */
	date: string;
	/** The entry currency to seed the picker with — the group's own when the Capture names none. */
	currency: string;
	currencyExponent: number;
	/** Minor units of `currency`, or 0 for a note-only Capture. */
	amountTotal: number;
	/**
	 * The Capture's currency is not the group's settlement currency, so the rate is
	 * left EMPTY for the user to enter: a Capture stores no rate and no conversion
	 * (§7.7), and seeding a plausible "1" would quietly record a wrong ledger figure.
	 */
	needsRate: boolean;
};

/**
 * Read the Capture named by `?capture=`, if it names an open one in this group.
 *
 * Falls back to `null` — never throws — on anything unusable, exactly like
 * {@link resolveTransferPrefill}: an absent param, a stale id, another group's row,
 * or one somebody already recorded or discarded. A dead link then renders the
 * ordinary blank add-transaction form (and saves an ordinary transaction, stamping
 * nothing), rather than an error page.
 */
async function resolveCapturePrefill({
	url,
	userId,
	groupId,
	entryCurrencies,
	settlementCurrency
}: {
	url: URL;
	userId: string;
	groupId: string;
	entryCurrencies: readonly GroupCurrency[];
	settlementCurrency: SeededCurrencyCode;
}): Promise<CapturePrefill | null> {
	const captureId = url.searchParams.get('capture');
	if (!captureId) {
		return null;
	}

	let capture;
	try {
		capture = await findOpenCapture({ userId, groupId, captureId });
	} catch {
		// A prefill is a convenience; a read failure must not cost the user the form.
		return null;
	}
	if (!capture) {
		return null;
	}

	// The stored code may no longer resolve — `captures.currency` is deliberately NOT
	// a foreign key (a custom currency deleted since leaves it dangling). Then the
	// amount has no scale to be read at, so it is dropped rather than guessed, and the
	// user re-enters it against the group's own currency.
	const descriptor =
		capture.currency === null
			? undefined
			: entryCurrencies.find((c) => c.code === capture.currency);
	const money =
		capture.amountMinor !== null && descriptor
			? { currency: descriptor.code, exponent: descriptor.exponent, amount: capture.amountMinor }
			: null;

	return {
		id: capture.id,
		title: capture.note,
		date: capture.capturedFor,
		currency: money?.currency ?? settlementCurrency,
		currencyExponent: money?.exponent ?? getCurrency(settlementCurrency)?.exponent ?? 2,
		amountTotal: money?.amount ?? 0,
		needsRate: money !== null && money.currency !== settlementCurrency
	};
}

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
	const { user, group } = await requireGroupAccess({
		locals,
		groupId: params.id,
		redirectTo: pathAndQuery(url)
	});

	const settlementCurrency = group.settlementCurrency as SeededCurrencyCode;
	const currency = getCurrency(settlementCurrency);

	// Every currency this group may RECORD IN (PLAN §7.5.2): the seeded 29 plus this
	// group's own custom rows. One query feeds three things that must agree — the
	// entry-currency picker, the group-scoped entry-currency validator, and the
	// resolved descriptors the §7.6 conversion needs (a custom code cannot be looked
	// up in the compiled-in seeded constant).
	const entryCurrencies = await loadEntryCurrencies(user.id, params.id, 'Group not found');

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
		memberIds: activeMembers.map((m) => m.id),
		entryCurrencies
	});

	// §8.4 settle-via-transfer prefill (task 5.4): if the settle page linked here
	// with valid `?type=transfer&from&to&amount&category` params (validated against
	// the TRUSTED active-member allow-list + transfer categories), seed a Transfer
	// (payer = debtor, single beneficiary = creditor, the amount, Debt settlement).
	// On ANY invalid/absent param this is null → the normal blank spending default
	// below is used unchanged (task 4.7's behavior is preserved).
	const prefill = resolveTransferPrefill(url, new Set(activeMembers.map((m) => m.id)));

	// "Record it" on the tray (issue #51; PLAN §7.7). Read only when the settle
	// prefill above didn't claim the form — the two links never carry each other's
	// params, and one seeded form can only come from one place.
	const capturePrefill = prefill
		? null
		: await resolveCapturePrefill({
				url,
				userId: user.id,
				groupId: params.id,
				entryCurrencies,
				settlementCurrency
			});

	// Seed a default form: spending / equal split, payer = the viewer's member,
	// beneficiaries = all active members. amountTotal 0 (the user fills it in).
	// When a valid Transfer prefill is present, seed THAT instead (the settlement
	// amount is already in minor units — no float parsing — and equals the
	// settlement total since the entry currency is the settlement currency).
	const baseDefaults = prefill
		? {
				type: 'transfer' as const,
				// Settle-up prefill (§8.4): seed the title so the required field is filled
				// and reads meaningfully. "Debt settlement" mirrors the transfer category;
				// still fully editable/clearable by the user.
				title: 'Debt settlement',
				// Editable real-world date (§7.1) — defaults to today (UTC); user can backdate.
				date: new Date().toISOString().slice(0, 10),
				categoryId: prefill.categoryId,
				amountTotal: prefill.amount,
				currency: settlementCurrency,
				// The scale the amounts are expressed at (§7.5.2) — the settlement
				// currency's here, since that is what the picker defaults to. The form
				// keeps it in step with the picker; seeding it makes the no-JS POST valid.
				currencyExponent: currency?.exponent ?? 2,
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
				// Editable real-world date (§7.1) — defaults to today (UTC); user can backdate.
				date: new Date().toISOString().slice(0, 10),
				// Neutral "Other", NOT the first category (Food & Drink) — see
				// `defaultCategoryFor`: a wrong guess looks deliberate and mislabels data.
				categoryId: defaultCategoryFor('spending'),
				amountTotal: 0,
				currency: settlementCurrency,
				// See the prefill branch: the entry currency's exponent travels with the
				// amounts it gives meaning to.
				currencyExponent: currency?.exponent ?? 2,
				exchangeRate: '1',
				amountTotalSettlement: 0,
				splitMode: 'equal' as const,
				payers: viewerMember ? [{ memberId: viewerMember.id, amountPaid: 0 }] : [],
				beneficiaries: activeMembers.map((m) => ({ memberId: m.id })),
				items: [],
				charges: []
			};

	// The Capture prefill (§7.7) OVERRIDES only what a Capture actually carries —
	// the note as the title, the day, and the amount + its currency. Payers,
	// beneficiaries and the split mode keep the blank default because a Capture holds
	// none of them (ADR-0012), so they are entered normally, and every field here
	// stays editable. `capturePrefill` is null whenever the settle prefill claimed the
	// form, so these two never overlap.
	const defaults = capturePrefill
		? {
				...baseDefaults,
				title: capturePrefill.title,
				// `captured_for` → the transaction's editable real-world `created_at` (§7.1).
				date: capturePrefill.date,
				currency: capturePrefill.currency,
				currencyExponent: capturePrefill.currencyExponent,
				amountTotal: capturePrefill.amountTotal,
				// A foreign amount arrives with NO rate — a Capture stores none (§7.7) — so
				// the rate is left blank for the user rather than guessed at 1, and the
				// settlement total follows once they enter it (the form recomputes it; the
				// schema refuses the save until then).
				exchangeRate: capturePrefill.needsRate ? '' : '1',
				amountTotalSettlement: capturePrefill.needsRate ? 0 : capturePrefill.amountTotal,
				// A single payer mirrors the total, exactly as the form itself keeps it.
				payers: viewerMember
					? [{ memberId: viewerMember.id, amountPaid: capturePrefill.amountTotal }]
					: []
			}
		: baseDefaults;

	const form = await superValidate(zod4(schema), { defaults });

	return {
		form,
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: toSettlementCurrencyView(settlementCurrency),
		// The group's entry-currency list for the FX picker (§7.6 / §7.5.2). The form
		// defaults the picker to the group settlement currency; choosing a different one
		// reveals the rate / settlement-total entry.
		currencies: toCurrencyOptions(entryCurrencies),
		members: activeMembers,
		viewerMemberId: viewerMember?.id ?? null,
		categories: toCategoryOptions(),
		// The Capture this form is recording, if any (issue #51). The page posts it
		// back in the action's query string, so the save can stamp it in the same DB
		// transaction; `null` (a plain visit, or a stale/closed link) saves an ordinary
		// transaction and stamps nothing.
		captureId: capturePrefill?.id ?? null
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals, url }) => {
		// Guard the mutation too — never trust that `load` ran. `requireUser` THROWS
		// the redirect; keep it above the validate/try below.
		const user = requireUser(locals, { redirectTo: pathAndQuery(url) });

		// Rebuild the shared schema server-side from TRUSTED group context — the
		// settlement currency, the active member allow-list and the group's entry
		// currencies, all re-read rather than taken from the payload.
		const { settlementCurrency, schema } = await loadTransactionWriteContext(
			user.id,
			params.id,
			'Group not found'
		);

		const form = await superValidate(request, zod4(schema));
		if (!form.valid) {
			// Invalid input → 400 form failure (errors render inline). Never a 500.
			return fail(400, { form });
		}

		// Recording a Capture (issue #51; PLAN §7.7 "Resolving")? The id rides in the
		// action's own query string — the same `?capture=` the prefill came from, which
		// the form posts back to and which survives a failed save (`load` re-runs at the
		// same URL). It is UNTRUSTED, exactly like the prefill: the service re-checks
		// membership, the group, and that the row is still open, inside the write.
		const captureId = url.searchParams.get('capture');

		try {
			if (captureId) {
				// ONE DB transaction: the transaction, its audit row, and the Capture's
				// `resolved_transaction_id` + `resolved_at` stamp (§12.1). The payload took
				// the SAME §7.4 validation above and inside the service — a prefill buys no
				// shortcut.
				await recordCaptureAsTransaction({
					userId: user.id,
					groupId: params.id,
					captureId,
					input: form.data,
					settlementCurrency
				});
			} else {
				await createTransaction({
					userId: user.id,
					groupId: params.id,
					input: form.data,
					settlementCurrency
				});
			}
		} catch (e) {
			if (e instanceof GroupAccessError) {
				error(404, 'Group not found');
			}
			if (e instanceof CaptureNotOpenError) {
				// The tray is GROUP-VISIBLE (§7.7), so this is a real race: someone else
				// recorded or discarded that note between opening this form and saving it.
				// NOTHING was written — the stamp failed inside the transaction, so the
				// transaction rolled back with it — and saying so is the point: this is the
				// double entry the tray exists to prevent, and the filled-in form is kept so
				// the user can check the list first and decide.
				return message(
					form,
					{
						type: 'error',
						text:
							e.reason === 'resolved'
								? 'Someone already recorded that one, so nothing was saved. Check the transaction list before adding it again.'
								: 'Someone already discarded that one, so nothing was saved. Check the transaction list before adding it again.'
					},
					{ status: 409 }
				);
			}
			if (e instanceof CaptureNotFoundError) {
				// A stale link (the note is not this group's, or never existed). Nothing was
				// written; the form itself is still valid, so it is kept rather than replaced
				// by a 404 page.
				return message(
					form,
					{ type: 'error', text: 'That note is no longer here, so nothing was saved.' },
					{ status: 404 }
				);
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
