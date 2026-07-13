// `v1` Member DTO + mapper (PLAN §16.4).
//
// Maps the internal `MemberListItem` read model (returned by `listMembers`) to
// the owned wire DTO. §16.4 pins the served field set — `id, displayName,
// userId, deactivatedAt, isLinked` — so this mapper is a faithful projection
// that carries no money and drops nothing beyond keeping the DTO owned (the seam
// still exists so an internal shape change can never silently reach the wire).
// `deactivatedAt` is already an ISO string (or null) in the read model.

import type { MemberListItem } from '$lib/server/members';

/** A group member as served by `/api/v1` (PLAN §16.4). */
export interface MemberDto {
	readonly id: string;
	readonly displayName: string;
	/** The linked better-auth user id, or null for an unlinked participant slot. */
	readonly userId: string | null;
	/** ISO string (or null) — non-null means the member is soft-deactivated (§6.3). */
	readonly deactivatedAt: string | null;
	/** Whether the slot maps to a real account (derived; §16.4 lists it in the DTO). */
	readonly isLinked: boolean;
}

/**
 * Map an internal {@link MemberListItem} to its wire {@link MemberDto}. PURE:
 * object → object, no DB/IO.
 */
export function toMemberDto(member: MemberListItem): MemberDto {
	return {
		id: member.id,
		displayName: member.displayName,
		userId: member.userId,
		deactivatedAt: member.deactivatedAt,
		isLinked: member.isLinked
	};
}
