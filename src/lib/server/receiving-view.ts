// Turning a group's members into the receiving details a payer may read
// (issue #86; PLAN §17.3–§17.4).
//
// One place builds this for BOTH surfaces — `/groups/[id]/settle` and member
// detail — because the two show exactly the same thing (PLAN §17.4: "Member
// detail — the same, on demand"), and two copies of the empty-state decision is
// two places for them to drift.
//
// ── The only read path is `listForViewer` ────────────────────────────────────
// Nothing here touches `receiving_method` directly. `listForViewer` is what
// re-derives visibility from shared co-membership on every read (PLAN §17.3), and
// routing around it is how "leaving a group revokes it" would quietly stop being
// true. A viewer who shares no group with the target gets [] — which lands on the
// same `no-methods` copy as a co-member with nothing recorded, on purpose: a
// viewer must not be able to tell the two apart.
//
// ── The empty-state decision is made from the MEMBER, not from the list ──────
// An unlinked member has no user id, so there is nothing to ask `listForViewer`
// about at all — the answer is an invite, not data entry (PLAN §17.1). That is why
// `unlinked` is decided here, before any read.
//
// Values are RESOLVED FOR DISPLAY here (a select's option label, not its stored
// value) so the component never sees the registry.

import { findRail, parseRailDetails } from './payout-rails';
import { listForViewer, type ReceivingMethod } from './receiving-methods';
import type { RailField } from '$lib/payout-rail-fields';
import type {
	ReceivingFieldView,
	ReceivingMethodView,
	ReceivingProfileView
} from '$lib/receiving-method-view';

/** A member, reduced to what the receiving lookup needs. */
export type ReceivingTarget = {
	id: string;
	/** The linked account, or null for a participant slot (PLAN §6.1). */
	userId: string | null;
};

/**
 * Build one {@link ReceivingProfileView} per target member, keyed by MEMBER id.
 *
 * Each linked user is read ONCE even if several targets point at them (they
 * cannot inside one group, but the callers pass member lists, not user lists).
 * Unlinked members cost no query at all.
 */
export async function loadReceivingProfiles(
	viewerUserId: string,
	targets: readonly ReceivingTarget[]
): Promise<Record<string, ReceivingProfileView>> {
	const userIds = [
		...new Set(targets.map((t) => t.userId).filter((id): id is string => id != null))
	];

	const profiles = new Map<string, ReceivingProfileView>(
		await Promise.all(
			userIds.map(
				async (userId) =>
					[userId, toProfileView(await listForViewer(viewerUserId, userId))] as const
			)
		)
	);

	return Object.fromEntries(
		targets.map((target) => [
			target.id,
			(target.userId && profiles.get(target.userId)) || { state: 'unlinked' as const }
		])
	);
}

/** A linked user's methods as the payer-facing view. Empty list → `no-methods`. */
export function toProfileView(methods: readonly ReceivingMethod[]): ReceivingProfileView {
	if (methods.length === 0) return { state: 'no-methods' };
	return { state: 'methods', methods: methods.map(toMethodView) };
}

/**
 * One stored row, rendered field by field.
 *
 * The details are re-validated through the registry gate first, and the PARSED
 * value is what gets read: a row whose `details` its rail no longer accepts yields
 * `fields: null` rather than a partial account number (see `ReceivingMethodView`).
 */
export function toMethodView(method: ReceivingMethod): ReceivingMethodView {
	const rail = findRail(method.rail);
	const parsed = parseRailDetails(method.rail, method.details);

	return {
		id: method.id,
		// A rail the registry no longer knows has no label to give; its own key is
		// still better than an empty heading over an "unavailable" notice.
		railLabel: rail?.label ?? method.rail,
		fields:
			rail && parsed.success ? rail.fields.map((field) => toFieldView(field, parsed.details)) : null
	};
}

/** One descriptor plus its parsed value, resolved to label + display text. */
function toFieldView(field: RailField, details: unknown): ReceivingFieldView {
	const raw = (details as Record<string, unknown> | null)?.[field.name];
	const value = raw === null || raw === undefined ? '' : String(raw);

	return {
		label: field.label,
		// A select stores a code (`kbank`); the payer needs the name the picker
		// showed. An unmatched value falls back to itself rather than to blank.
		value: field.options?.find((option) => option.value === value)?.label ?? value,
		payerRole: field.payerRole
	};
}
