// `v1` Group DTO + mapper (PLAN §16.4).
//
// Maps the internal `Group` read model (`typeof groups.$inferSelect`) to the
// owned wire DTO. Two deliberate transforms:
//   - DROP `deletedAt` — an internal soft-delete marker; a deleted group is never
//     served, so its delete time has no place on the public wire (§16.4).
//   - SERIALIZE `createdAt` (a `Date`) as an ISO-8601 string — the wire is JSON.
// `settlementCurrency` is a currency CODE (not a monetary amount), so it stays a
// scalar — the money-on-wire `{ amount, currency }` shape is for AMOUNTS only.

import type { SeededCurrencyCode } from '$lib/money';
import type { Group } from '$lib/server/groups';

/** A group as served by `/api/v1` (PLAN §16.4). Internal `deletedAt` is dropped. */
export interface GroupDto {
	readonly id: string;
	readonly name: string;
	/** The group's settlement currency (ISO code) — every settlement amount is in this. */
	readonly settlementCurrency: SeededCurrencyCode;
	/** better-auth user id of the group's author. */
	readonly createdBy: string;
	/** Creation time, ISO-8601 string (serialized from the internal `Date`). */
	readonly createdAt: string;
}

/**
 * Map an internal {@link Group} read model to its wire {@link GroupDto}. PURE:
 * object → object, no DB/IO. Drops `deletedAt` and ISO-serializes `createdAt`.
 */
export function toGroupDto(group: Group): GroupDto {
	return {
		id: group.id,
		name: group.name,
		// DB stores a validated ISO code as `text`; it IS a SeededCurrencyCode on the wire.
		settlementCurrency: group.settlementCurrency as SeededCurrencyCode,
		createdBy: group.createdBy,
		createdAt: group.createdAt.toISOString()
	};
}
