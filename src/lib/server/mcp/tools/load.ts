// Loading helpers shared by the group-scoped tools.
//
// ── Why a `null` group becomes a THROW ──────────────────────────────────────
// `getGroupForUser` returns `null` for a group that does not exist, one that is
// soft-deleted, AND one the caller simply cannot see — deliberately conflated, so an
// id-probing agent can never tell them apart (PLAN §16.5 / §12). Turning that `null`
// into `GroupAccessError` funnels it through the dispatcher's `mapToolError`, which
// emits the SAME `not_found` body that a genuinely absent id produces, byte for byte.
// Every group-scoped tool therefore inherits the conflation by construction instead
// of re-implementing it (and eventually getting it subtly wrong in one place).

import { getGroupForUser, GroupAccessError } from '$lib/server/groups';
import { listMembers } from '$lib/server/members';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import { toGroupView, toMemberView, type GroupView, type MemberView } from '../view';

/**
 * The group as the caller may see it, or `GroupAccessError` (→ the conflated
 * `not_found`). Also the group-scoped tools' ACCESS GATE.
 */
export async function loadGroupView(
	principal: ApiKeyPrincipal,
	groupId: string
): Promise<GroupView> {
	const group = await getGroupForUser(principal.userId, groupId);
	if (!group) {
		// Absent / deleted / not-yours — ONE outcome, no existence oracle.
		throw new GroupAccessError();
	}
	return toGroupView(group, principal);
}

/**
 * The group's roster, with the caller marked (`isYou`). `listMembers` is itself
 * access-checked (it throws `GroupAccessError`), so this is safe to call on its own.
 * Includes DEACTIVATED members (§6.3): they are still in the ledger, still owe and
 * are owed, and a transaction may name them.
 */
export async function loadMemberViews(
	principal: ApiKeyPrincipal,
	groupId: string
): Promise<MemberView[]> {
	const members = await listMembers({ userId: principal.userId, groupId });
	return members.map((m) => toMemberView(m, principal));
}
