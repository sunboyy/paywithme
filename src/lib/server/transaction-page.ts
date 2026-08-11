// The pieces every transaction ROUTE (`/groups/[id]/transactions`, `…/new`,
// `…/[txid]`) puts on the wire, and the trusted context its write actions rebuild the
// shared schema from.
//
// These are not three coincidentally similar payloads: the list, the add form and the
// view/edit page render the SAME amounts through the same components, so they must
// agree on the currency descriptors, the category sets, and the member allow-list the
// validator uses. Building each independently is how they eventually stop agreeing —
// a currency field added to the picker on one page and not another, or a schema
// rebuilt from a slightly different member set on one action than the other.

import { error } from '@sveltejs/kit';
import { buildTransactionSchema } from '$lib/schemas/transaction';
import { categoriesFor } from '$lib/categories';
import { getCurrency, type SeededCurrencyCode } from '$lib/money';
import { listCurrenciesForGroup, type GroupCurrency } from './currencies';
import { getGroupForUser, GroupAccessError } from './groups';
import { listMembers } from './members';

/**
 * The group's permitted ENTRY currencies (PLAN §7.5.2): the seeded 29 plus this
 * group's own custom rows. Access was already established by the caller, so a
 * `GroupAccessError` here can only be a race (the group vanished mid-request) —
 * answered the way every other lookup on these routes answers it, with a 404 that
 * never distinguishes "gone" from "never yours" (§12). `notFoundMessage` is the
 * route's own wording ("Group not found" / "Transaction not found"); everything else
 * propagates.
 */
export async function loadEntryCurrencies(
	userId: string,
	groupId: string,
	notFoundMessage: string
): Promise<GroupCurrency[]> {
	try {
		return await listCurrenciesForGroup({ userId, groupId });
	} catch (e) {
		if (e instanceof GroupAccessError) {
			error(404, notFoundMessage);
		}
		throw e;
	}
}

/**
 * The group's SETTLEMENT currency as the pages render it. Always one of the seeded 29
 * (ADR-0014 decision 1), where `displayCode === code` by definition; the fallback
 * keeps the payload total if a group somehow carries a code the seeded constant does
 * not know, rather than shipping `undefined` into a formatter.
 */
export function toSettlementCurrencyView(settlementCurrency: SeededCurrencyCode) {
	const currency = getCurrency(settlementCurrency);
	return currency
		? {
				code: currency.code,
				displayCode: currency.code,
				symbol: currency.symbol,
				exponent: currency.exponent
			}
		: {
				code: settlementCurrency,
				displayCode: settlementCurrency,
				symbol: settlementCurrency,
				exponent: 2
			};
}

/**
 * The entry-currency picker's options. `displayCode` is what the picker renders; the
 * opaque `code` is only ever the posted value (a group-defined currency's key is a
 * `cur_…` that must never reach the screen — CONTEXT.md "Display code").
 */
export function toCurrencyOptions(entryCurrencies: readonly GroupCurrency[]) {
	return entryCurrencies.map((c) => ({
		code: c.code,
		displayCode: c.displayCode,
		symbol: c.symbol,
		exponent: c.exponent,
		name: c.name
	}));
}

/**
 * Both category sets, so the client can swap the picker when the type toggles (and so
 * the list page's filter can offer whichever set the active type implies).
 */
export function toCategoryOptions() {
	return {
		spending: categoriesFor('spending').map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
		transfer: categoriesFor('transfer').map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
	};
}

/**
 * The TRUSTED group context a transaction write action rebuilds the shared schema
 * from — the settlement currency, the ACTIVE member allow-list, and the group-scoped
 * entry-currency set, every one of them re-read here rather than taken from the
 * payload. Shared by the add and edit actions so the two can never validate against
 * different notions of what this group permits.
 *
 * 404s (with the route's own wording) when the group is gone or was never the
 * caller's — existence is never leaked (§12).
 */
export async function loadTransactionWriteContext(
	userId: string,
	groupId: string,
	notFoundMessage: string
) {
	const group = await getGroupForUser(userId, groupId);
	if (!group) {
		error(404, notFoundMessage);
	}
	const settlementCurrency = group.settlementCurrency as SeededCurrencyCode;

	const activeMembers = (await listMembers({ userId, groupId })).filter(
		(m) => m.deactivatedAt === null
	);
	const entryCurrencies = await loadEntryCurrencies(userId, groupId, notFoundMessage);

	return {
		settlementCurrency,
		schema: buildTransactionSchema({
			settlementCurrency,
			memberIds: activeMembers.map((m) => m.id),
			entryCurrencies
		})
	};
}
