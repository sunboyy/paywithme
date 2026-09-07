// `/groups/[id]/transactions` — the group transaction list (task 4.7; PLAN §7,
// §10). Access-checked `load` returns the (filtered) list + the current filter
// state parsed from `url.searchParams`. The page renders a mobile-first list with
// a type/category/member filter and an empty state.
//
// SCOPE (4.7): list + filter by type/category, later extended with the §10 MEMBER
// filter ("show only what relates to me" — a member id plus an optional `role`
// narrowing it to the paying or the benefiting side). Each row links to
// `/groups/[id]/transactions/[txid]` (the view/edit page is task 4.11; the link
// can exist now). Balances/settlement (Phase 5) and the activity feed (6.2) are
// elsewhere.
//
// THE "NOT RECORDED YET" TRAY (issue #50; PLAN §7.7) sits ABOVE the list here, and
// its `discard` form action lives in this file. The tray is the group's OPEN
// Captures, each attributed to its author — attribution is what makes it
// deduplicate, so the author name is resolved from the member roster this page
// ALREADY loads for the member filter (no extra query). Resolving a Capture into a
// transaction is a separate slice (#51); this page shows and discards only.

import { error, fail } from '@sveltejs/kit';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { pathAndQuery } from '$lib/redirect';
import { GroupAccessError } from '$lib/server/groups';
import { listTransactions, type TransactionListItem } from '$lib/server/transactions';
import { listMembers } from '$lib/server/members';
import {
	discardCapture,
	listOpenCaptures,
	CaptureNotFoundError,
	CaptureNotOpenError,
	type Capture
} from '$lib/server/captures';
import { formatAmount, type CurrencyDescriptor, type SeededCurrencyCode } from '$lib/money';
import {
	loadEntryCurrencies,
	toCategoryOptions,
	toSettlementCurrencyView
} from '$lib/server/transaction-page';
import type { TrayCapture } from '$lib/components/NotRecordedYetTray.svelte';
import type { Actions, PageServerLoad } from './$types';

/** Parse the `type` filter from the query string (ignoring anything unrecognized). */
function parseTypeFilter(raw: string | null): 'spending' | 'transfer' | undefined {
	return raw === 'spending' || raw === 'transfer' ? raw : undefined;
}

/**
 * Parse the `role` filter — which SIDE of the transaction the `member` filter means
 * (`paid` = they paid, `owes` = they benefited). Anything unrecognized (including
 * absent) is `undefined`, i.e. EITHER side: the "relates to me" default.
 */
function parseRoleFilter(raw: string | null): 'paid' | 'owes' | undefined {
	return raw === 'paid' || raw === 'owes' ? raw : undefined;
}

/** One entry in the member filter's dropdown. */
export interface MemberFilterOption {
	id: string;
	displayName: string;
	/** The viewer's OWN member slot — pinned first and labelled "Me". */
	isSelf: boolean;
	/** Soft-deactivated (§6.3). Still filterable: they keep their history. */
	isInactive: boolean;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	// Centralized guard: anonymous → redirect; no-access/not-found → 404. Returns
	// the already-loaded group. THROWS control flow → outside any try/catch.
	const { user, group } = await requireGroupAccess({
		locals,
		groupId: params.id,
		redirectTo: pathAndQuery(url)
	});

	const settlementCurrency = group.settlementCurrency as SeededCurrencyCode;

	// The group's currency set (seeded 29 + this group's custom rows, PLAN §7.5.2).
	// The rows below show the ORIGINAL amount in its ENTRY currency (§7.6 Display),
	// and a group-defined currency exists only as a `currencies` row — formatting it
	// from its bare code would throw, so the resolved descriptors travel to the page.
	//
	// NOT degraded to an empty list on failure. The members read below tolerates a
	// failure because "no member filter offered" is a coherent page; an empty CURRENCY
	// set is not — a row recorded in a custom currency then has no descriptor to format
	// with and the component throws anyway, just later and with a worse message. So the
	// only tolerated failure is the `GroupAccessError` race the transaction read below
	// also maps to a 404; anything else is a real fault and propagates.
	const entryCurrencies = (await loadEntryCurrencies(user.id, params.id, 'Group not found')).map(
		(c) => ({
			code: c.code,
			displayCode: c.displayCode,
			symbol: c.symbol,
			exponent: c.exponent
		})
	);

	// Filter state from the URL (server-first: links carry the filter so it works
	// without JS). An unknown type/category simply yields no filter / no matches.
	const typeFilter = parseTypeFilter(url.searchParams.get('type'));
	const categoryFilter = url.searchParams.get('category') ?? undefined;
	// "Only what relates to <person>": a member id, optionally narrowed to one side
	// by `role`. An unknown member id simply matches nothing (same as an unknown
	// category); a `role` without a `member` has no meaning and is dropped here so
	// it can never reach the service.
	const memberFilter = url.searchParams.get('member') || undefined;
	const roleFilter = memberFilter ? parseRoleFilter(url.searchParams.get('role')) : undefined;

	let transactions: TransactionListItem[];
	try {
		transactions = await listTransactions({
			userId: user.id,
			groupId: params.id,
			filters: {
				type: typeFilter,
				categoryId: categoryFilter,
				memberId: memberFilter,
				memberRole: roleFilter
			}
		});
	} catch (e) {
		// A real access/not-found here would be a race (the group vanished between
		// the access check and the list read) — re-surface as 404; otherwise degrade
		// to an empty list rather than 500-ing the whole page (PLAN §12).
		if (e instanceof GroupAccessError) {
			error(404, 'Group not found');
		}
		transactions = [];
	}

	// The people the member filter can select. Deactivated members are INCLUDED —
	// they keep their historical transactions (§6.3), so hiding them would make
	// their rows unreachable from this filter. A read failure here degrades to "no
	// member filter offered" rather than 500-ing a page whose list already loaded.
	let memberRows: Awaited<ReturnType<typeof listMembers>>;
	try {
		memberRows = await listMembers({ userId: user.id, groupId: params.id });
	} catch {
		memberRows = [];
	}
	const members: MemberFilterOption[] = memberRows.map((m) => ({
		id: m.id,
		displayName: m.displayName,
		isSelf: m.userId === user.id,
		isInactive: m.deactivatedAt !== null
	}));

	// ── The "Not recorded yet" tray (PLAN §7.7 "Recall (no push)") ───────────────
	// EVERY member sees EVERY member's open Captures — the service applies no author
	// filter and there must not be one, because the tray's job is deduplication.
	//
	// Degraded to an empty tray on a non-access failure, like the member read above:
	// the transaction list is this page's job, and a missing tray is a coherent page.
	let openCaptures: Capture[];
	try {
		openCaptures = await listOpenCaptures(user.id, params.id);
	} catch (e) {
		if (e instanceof GroupAccessError) {
			error(404, 'Group not found');
		}
		openCaptures = [];
	}

	return {
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: toSettlementCurrencyView(settlementCurrency),
		currencies: entryCurrencies,
		transactions,
		members,
		captures: toTrayCaptures(openCaptures, memberRows, entryCurrencies, settlementCurrency),
		filters: {
			type: typeFilter ?? null,
			category: categoryFilter ?? null,
			member: memberFilter ?? null,
			role: roleFilter ?? null
		},
		// The category lists drive the filter Select (only the matching set when a
		// type is active; both otherwise).
		categories: toCategoryOptions()
	};
};

export const actions: Actions = {
	// Give up on a Capture without recording it (PLAN §7.7 "Edge cases") — a SOFT
	// discard, with the audit row the service writes in the same DB transaction.
	//
	// This IS the destructive action; the Alert Dialog in the tray is a UX guard on
	// top of it (§10), so this must — and does — work on its own with JS off.
	discard: async ({ request, params, locals, url }) => {
		// Guard the mutation itself; never trust that `load` ran. THROWS the redirect.
		const user = requireUser(locals, { redirectTo: pathAndQuery(url) });

		const data = await request.formData();
		const captureId = data.get('captureId');
		if (typeof captureId !== 'string' || captureId === '') {
			return fail(400, {
				message: { type: 'error', text: 'Could not discard that. Please try again.' }
			} satisfies DiscardOutcome);
		}

		try {
			await discardCapture({ userId: user.id, groupId: params.id, captureId });
		} catch (e) {
			if (e instanceof GroupAccessError) {
				error(404, 'Group not found');
			}
			if (e instanceof CaptureNotFoundError) {
				// A stale page pointing at a row that isn't this group's. Answered as a
				// form failure rather than a 404 page: the list beside it is still valid,
				// and a mis-tap should not blow the screen away.
				return fail(404, {
					message: { type: 'error', text: 'That note is no longer here.' }
				} satisfies DiscardOutcome);
			}
			if (e instanceof CaptureNotOpenError) {
				// The tray is GROUP-VISIBLE, so this is a real race, not a defensive
				// nicety: someone else closed the row between the render and the tap.
				// Saying which ending it got is the point — "it worked" would be a lie.
				return fail(409, {
					message: {
						type: 'error',
						text:
							e.reason === 'resolved'
								? 'Someone already recorded that one.'
								: 'Someone already discarded that one.'
					}
				} satisfies DiscardOutcome);
			}
			// Never leak the raw cause (PLAN §12).
			return fail(500, {
				message: { type: 'error', text: 'Could not discard that. Please try again.' }
			} satisfies DiscardOutcome);
		}

		// `load` re-runs on the way back, so the row leaves the tray on its own.
		return { message: { type: 'success', text: 'Discarded' } } satisfies DiscardOutcome;
	}
};

/** What the `discard` action hands back — a whole-form banner, never a field rule. */
export type DiscardOutcome = { message: App.Superforms.Message };

/**
 * Shape the group's open Captures for the tray (PLAN §7.7).
 *
 * ── Attribution comes from the roster this page already loaded ────────────────
 * A Capture stores `created_by` (a user id, the durable key), and the tray must
 * name a PERSON. Every author necessarily holds a member row in this group — that
 * is what `userHasGroupAccess` required of them to write it — and the roster
 * includes DEACTIVATED members (§6.3), so an author who has since left still
 * resolves. "Someone" is the last resort, mirroring the activity feed's fallback
 * rather than printing a raw user id at a reader.
 *
 * ── The amount is FORMATTED, never converted ─────────────────────────────────
 * Rendering it needs the exponent of a currency that may exist only as a
 * `currencies` row, which is why it is done here where the group's set is loaded.
 * Nothing is converted: there is no rate and no settlement equivalent, because
 * nothing that computes a balance may see a Capture (§7.7). A code with no
 * descriptor left — `captures.currency` is deliberately NOT a foreign key, so a
 * custom currency deleted afterwards leaves one dangling — renders as no amount at
 * all rather than at a guessed scale.
 */
function toTrayCaptures(
	openCaptures: readonly Capture[],
	memberRows: readonly { displayName: string; userId: string | null }[],
	entryCurrencies: readonly CurrencyDescriptor[],
	settlementCurrency: SeededCurrencyCode
): TrayCapture[] {
	const authorNames = new Map(
		memberRows.filter((m) => m.userId !== null).map((m) => [m.userId as string, m.displayName])
	);
	const byCode = new Map(entryCurrencies.map((c) => [c.code, c]));

	return openCaptures.map((capture) => {
		const descriptor = capture.currency === null ? undefined : byCode.get(capture.currency);
		return {
			id: capture.id,
			note: capture.note,
			authorName: authorNames.get(capture.createdBy) ?? 'Someone',
			amountFormatted:
				capture.amountMinor !== null && descriptor
					? // The ISO code rides along only for a FOREIGN currency, exactly as the
						// transaction rows below do — the group states its own currency once.
						formatAmount(capture.amountMinor, descriptor, {
							code: descriptor.code !== settlementCurrency
						})
					: null,
			capturedFor: capture.capturedFor
		};
	});
}
