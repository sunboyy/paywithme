// What a PAYER sees when they open someone's receiving details — the serializable
// shape `load` sends to the settle screen and member detail (issue #86;
// PLAN §17.3–§17.4).
//
// This is the read side's counterpart to `$lib/payout-rail-fields`, and it lives
// outside `lib/server/` for the same reason: the rail registry is server-only, so
// the component that renders these has to be handed plain data. Every value here
// is already resolved for display — a select's OPTION LABEL rather than its stored
// value — so the component never touches the registry and never branches on a rail.
//
// The states below are the empty-state decision from PLAN §17.4, made on the
// server where the member row lives. `listForViewer` cannot make it: it answers []
// both for a co-member with no methods and for a user the viewer shares no group
// with, and the surfaces pick their copy from the MEMBER they are already looking
// at.

import type { RailFieldPayerRole } from './payout-rail-fields';

/** One field of a method, resolved for reading. */
export type ReceivingFieldView = {
	/** The rail's own field label, e.g. "Account number". */
	label: string;
	/** The display value: an option's label for a select, the stored text otherwise. */
	value: string;
	/** What this field is to the payer (copy target / the name to check), if anything. */
	payerRole?: RailFieldPayerRole;
};

/** One receiving method, as a payer reads it. */
export type ReceivingMethodView = {
	id: string;
	/** The rail's own label, e.g. "PromptPay". */
	railLabel: string;
	/**
	 * The method's fields in the rail's own order, or `null` when the rail refuses
	 * to render them (details that no longer satisfy its schema, or a rail the
	 * registry no longer has).
	 *
	 * `null` is NOT the same as dropping the method: the payer is about to copy an
	 * account number, so half a rendering is worse than none — but silently hiding
	 * the row would turn a broken method into "they have no receiving method",
	 * which is a different and false statement.
	 */
	fields: ReceivingFieldView[] | null;
};

/**
 * A member's receiving details as this viewer may see them — one of the PLAN
 * §17.4 outcomes.
 *
 * - `unlinked` — the member is a participant slot with no account, so there will
 *   never be anything here until they join. The surface shows the invite link.
 * - `no-methods` — a real user who has not added one. Nothing to offer: v1 has no
 *   notifications, so the app must not imply it can nudge them.
 * - `own-empty` — the same emptiness, except the member IS the viewer AND the
 *   surface has established that someone owes them money. Another person's blank
 *   profile is a dead end; the viewer's own is a thing they can fix in one tap, so
 *   it gets the link instead of the sentence (PLAN §17.4 case 3). A surface with
 *   no such gate leaves the viewer on `no-methods` — see `promptViewerToAdd`.
 * - `methods` — never empty; the first is the preferred one (PLAN §17.1).
 */
export type ReceivingProfileView =
	| { state: 'unlinked' }
	| { state: 'no-methods' }
	| { state: 'own-empty' }
	| { state: 'methods'; methods: ReceivingMethodView[] };
