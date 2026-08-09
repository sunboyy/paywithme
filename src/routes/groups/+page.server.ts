// `/groups` dashboard server logic (PLAN §6, §10).
//
// Server-first: `load` lists the authenticated user's accessible groups via the
// task-3.3 group service (`listGroupsForUser`) — this route NEVER reimplements
// group logic. Anonymous hits go to login.
//
// Each card carries the caller's OWN net position in that group (PLAN §10's
// "net balances on the dashboard"). The cards previously showed only the
// settlement currency, which answers a question nobody opens the app to ask —
// "do I owe anyone?" is the reason for the visit. Balance math is NOT
// reimplemented here: it comes from the §8.1 service.

import { listGroupsForUser } from '$lib/server/groups';
import type { Group } from '$lib/server/groups';
import { getUserNetBalanceByGroup } from '$lib/server/balances';
import { requireUser } from '$lib/server/access';
import { pathAndQuery } from '$lib/redirect';
import { formatAmount, type CurrencyCode } from '$lib/money';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// The dashboard is per-user (it lists the caller's own groups), so an
	// anonymous request goes to login (task 3.8 centralized `requireUser`). It
	// THROWS the redirect, so it lives OUTSIDE the try/catch below or the catch
	// would swallow the navigation.
	const user = requireUser(locals, { redirectTo: pathAndQuery(url) });

	// Degrade gracefully (PLAN §12): a transient list failure renders an empty
	// list, not a 500. A brand-new user legitimately has zero groups, so an empty
	// list is also a normal state (the page shows a friendly empty state for it).
	let groups: Group[];
	try {
		groups = await listGroupsForUser(user.id);
	} catch {
		groups = [];
	}

	// ONE batched lookup for every group (not a query per card). Same graceful
	// degradation: if balances fail, the cards still render — they just omit the
	// figure rather than 500ing the dashboard.
	let netByGroup = new Map<string, number>();
	try {
		netByGroup = await getUserNetBalanceByGroup({
			userId: user.id,
			groupIds: groups.map((g) => g.id)
		});
	} catch {
		netByGroup = new Map();
	}

	return {
		groups: groups.map((group) => {
			const settlementCurrency = group.settlementCurrency as CurrencyCode;
			const net = netByGroup.get(group.id);
			return {
				...group,
				// `null` = "we could not determine it" (distinct from 0 = settled up),
				// so the card can stay silent rather than claim you're square.
				net: net ?? null,
				// Formatted ABSOLUTE value — the card supplies the "you are owed" /
				// "you owe" wording, so a bare "-¥21,560" beside "you owe" would
				// double-negate. The ISO code stays here: the dashboard is the one
				// screen where several currencies genuinely sit side by side.
				netFormatted: net === undefined ? null : formatAmount(Math.abs(net), settlementCurrency)
			};
		})
	};
};
