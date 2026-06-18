// `/groups/[id]/activity` — the group activity feed (task 6.2; PLAN §12.1, §10).
//
// Server-first read-only page: `load` guards with `requireGroupAccess`, parses the
// optional `?entity=<type>` / `?actor=<userId>` filters from the URL (so filter
// links carry state and work without JS), and returns the (filtered) feed newest
// first plus the data the page needs to render the actor filter as a member list.
//
// SCOPE (6.2): the GROUP-LEVEL feed only. The per-transaction history view (entries
// filtered to one entity_id) is the SEPARATE task 6.3. This page performs NO
// mutation, so it writes NO audit row.

import { error } from '@sveltejs/kit';
import { requireGroupAccess } from '$lib/server/access';
import { GroupAccessError } from '$lib/server/groups';
import { listGroupActivity, parseEntityTypeFilter, type ActivityEntry } from '$lib/server/activity';
import { listMembers } from '$lib/server/members';
import { AUDIT_ENTITY_TYPES } from '$lib/server/audit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	// Centralized guard: anonymous → redirect; no-access/not-found → 404. Returns
	// the already-loaded group. THROWS control flow → outside any try/catch.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	// Filter state from the URL (server-first: links carry the filter so it works
	// without JS). An unrecognized entity type / actor simply yields no filter.
	const entityFilter = parseEntityTypeFilter(url.searchParams.get('entity'));
	const actorFilter = url.searchParams.get('actor') ?? undefined;

	// The roster drives the actor-filter list. Only LINKED members (userId != null)
	// can be the actor of an audited action, so the filter options are built from
	// those. Loaded outside the try so an access race here surfaces as 404.
	const members = await listMembers({ userId: user.id, groupId: params.id });

	let entries: ActivityEntry[];
	try {
		entries = await listGroupActivity({
			userId: user.id,
			groupId: params.id,
			filters: { entityType: entityFilter, actorUserId: actorFilter }
		});
	} catch (e) {
		// A real access/not-found here would be a race (the group vanished between the
		// access check and the read) — re-surface as 404; otherwise degrade to an empty
		// feed rather than 500-ing the whole page (PLAN §12), mirroring the txn list.
		if (e instanceof GroupAccessError) {
			error(404, 'Group not found');
		}
		entries = [];
	}

	return {
		group: { id: group.id, name: group.name },
		entries,
		// Actor filter options: label = member display name, value = their linked userId
		// (only linked members can be actors). Distinct on userId for safety.
		actors: members
			.filter((m) => m.userId != null)
			.map((m) => ({ userId: m.userId as string, displayName: m.displayName })),
		// The constrained entity-type set for the entity filter control.
		entityTypes: [...AUDIT_ENTITY_TYPES],
		// Current filter state (echoed so the page can highlight active filters).
		filters: { entity: entityFilter ?? null, actor: actorFilter ?? null }
	};
};
