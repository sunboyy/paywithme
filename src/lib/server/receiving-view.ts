// Turning a group's members into the receiving details a payer may read
// (issue #86; PLAN §17.3–§17.4).
//
// One place builds this for BOTH surfaces — `/groups/[id]/settle` and member
// detail — because the two show exactly the same thing (PLAN §17.4: "Member
// detail — the same, on demand"), and two copies of the empty-state decision is
// two places for them to drift.
//
// ── Somebody else is only ever read through `listForViewer` ─────────────────
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
// ── The viewer's own profile is read with `listOwn` (PLAN §17.4 case 3) ──────
// The one target that is not somebody else is the viewer. Visibility is not the
// question there — nobody has to share a group with themselves to be told their
// own profile is empty — and the prompt claims something about MY profile, not
// about what I happen to be able to see of it. So the self case goes through the
// owner read.
//
// Whether an empty answer then becomes `own-empty` — the "add how people should
// pay you" prompt — is OPT-IN per call site, and off by default. PLAN §17.4 is
// specific about when the ask is earned: the viewer is looking at a screen that
// says people owe them money. A surface that has not established that (the members
// roster, which lists everyone regardless of balance) would be asking for bank
// details before there is a reason to give them, which is the onboarding step the
// plan refuses to add. Off by default means a new surface has to say it qualifies.
//
// ── The code is built here too, per TARGET (issue #88; ADR-0017) ─────────────
// A target may carry the AMOUNT its surface is asking for, and a method whose rail
// can encode one then comes back with a scannable code carrying that figure. That
// is why targets are keyed by an arbitrary id rather than by member: one creditor
// can be owed by two people for two different amounts, and each row's code must
// carry its own. The rail decides whether a payload exists at all — this module
// never learns what is inside one.
//
// Values are RESOLVED FOR DISPLAY here (a select's option label, not its stored
// value) so the component never sees the registry.

import { buildRailQr, findRail, parseRailDetails } from './payout-rails';
import { listForViewer, listOwn, type ReceivingMethod } from './receiving-methods';
import { toQrSvg } from './qr-code';
import { formatAmount, type SeededCurrencyCode } from '$lib/money';
import type { RailField } from '$lib/payout-rail-fields';
import type {
	ReceivingFieldView,
	ReceivingMethodView,
	ReceivingProfileView,
	ReceivingQrView
} from '$lib/receiving-method-view';

/**
 * The transfer a surface is asking the payer to make (issue #88).
 *
 * Passing one is what turns a method into a SCANNABLE code with the figure
 * already in it. A surface that is not naming an amount — the members roster,
 * which lists people rather than debts — passes none and shows the details alone:
 * a code carrying no figure, on a screen that also carries no figure, invites the
 * payer to assume the amount is in there when it is not.
 */
export type ReceivingAmount = {
	/** Integer minor units of `currency` — never a float (CLAUDE.md; PLAN §7.5). */
	amount: number;
	/** The group's settlement currency. Rails that cannot carry it produce no code. */
	currency: SeededCurrencyCode;
};

/** A member, reduced to what the receiving lookup needs. */
export type ReceivingTarget = {
	/**
	 * The key this target's profile comes back under.
	 *
	 * Usually the member id — but the settle screen keys by SUGGESTED TRANSFER,
	 * because one creditor can be owed by two people for two different amounts, and
	 * the code in each row has to carry that row's figure.
	 */
	id: string;
	/** The linked account, or null for a participant slot (PLAN §6.1). */
	userId: string | null;
	/** What this row is asking for, when the surface knows. */
	amount?: ReceivingAmount;
};

/** Per-surface choices about what an empty profile is allowed to say. */
export type ReceivingProfileOptions = {
	/**
	 * May the viewer's OWN empty profile answer `own-empty` instead of
	 * `no-methods` (PLAN §17.4 case 3)?
	 *
	 * Only a surface that has already established the viewer is OWED money may
	 * turn this on — on the settle screen, that is the creditor gate the caller
	 * applies before it picks its targets. Everywhere else the viewer's own blank
	 * reads like everyone else's, because an unearned ask is the onboarding step
	 * PLAN §17.4 rules out.
	 */
	promptViewerToAdd?: boolean;
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
	targets: readonly ReceivingTarget[],
	{ promptViewerToAdd = false }: ReceivingProfileOptions = {}
): Promise<Record<string, ReceivingProfileView>> {
	const userIds = [
		...new Set(targets.map((t) => t.userId).filter((id): id is string => id != null))
	];

	// Each user is READ once; the view is BUILT per target, because two targets can
	// name the same creditor for different amounts and each needs its own code.
	const methodsByUser = new Map<string, readonly ReceivingMethod[]>(
		await Promise.all(
			userIds.map(async (userId) => {
				const methods =
					userId === viewerUserId
						? await listOwn(userId)
						: await listForViewer(viewerUserId, userId);
				return [userId, methods] as const;
			})
		)
	);

	return Object.fromEntries(
		targets.map((target) => {
			const methods = target.userId && methodsByUser.get(target.userId);
			if (!methods) return [target.id, { state: 'unlinked' as const }];

			const isViewer = target.userId === viewerUserId;
			return [target.id, toProfileView(methods, isViewer && promptViewerToAdd, target.amount)];
		})
	);
}

/**
 * A linked user's methods as the payer-facing view.
 *
 * An empty list is `no-methods` — or `own-empty` when `promptViewerToAdd` says
 * this is the viewer's own profile ON A SURFACE THAT HAS EARNED THE ASK (PLAN
 * §17.4 case 3). It changes nothing about a profile that HAS methods: seeing your
 * own details on the settle screen is seeing exactly what the person paying you
 * sees.
 */
export function toProfileView(
	methods: readonly ReceivingMethod[],
	promptViewerToAdd = false,
	amount?: ReceivingAmount
): ReceivingProfileView {
	if (methods.length === 0) return { state: promptViewerToAdd ? 'own-empty' : 'no-methods' };
	return { state: 'methods', methods: methods.map((method) => toMethodView(method, amount)) };
}

/**
 * One stored row, rendered field by field.
 *
 * The details are re-validated through the registry gate first, and the PARSED
 * value is what gets read: a row whose `details` its rail no longer accepts yields
 * `fields: null` rather than a partial account number (see `ReceivingMethodView`).
 */
export function toMethodView(
	method: ReceivingMethod,
	amount?: ReceivingAmount
): ReceivingMethodView {
	const rail = findRail(method.rail);
	const parsed = parseRailDetails(method.rail, method.details);
	const renderable = rail !== undefined && parsed.success;

	return {
		id: method.id,
		// A rail the registry no longer knows has no label to give; its own key is
		// still better than an empty heading over an "unavailable" notice.
		railLabel: rail?.label ?? method.rail,
		fields: renderable ? rail.fields.map((field) => toFieldView(field, parsed.details)) : null,
		// No code beside details we are already refusing to render.
		qr: amount && renderable ? toQrView(method, amount) : null
	};
}

/**
 * The scannable code for one method and one amount, or `null`.
 *
 * The rail decides whether a payload exists at all (`buildRailQr` — it may have no
 * encoder, or refuse the currency); this only draws whatever comes back. NOTHING
 * HERE KNOWS WHICH RAIL IT IS HOLDING, which is what keeps ADR-0016's "no rail is
 * privileged" true on the read surfaces.
 */
function toQrView(method: ReceivingMethod, { amount, currency }: ReceivingAmount) {
	try {
		const payload = buildRailQr(method.rail, method.details, { amount, currency });
		if (!payload) return null;

		const { size, path } = toQrSvg(payload);
		// The caption reads the SAME minor units the payload encoded, formatted by the
		// money layer — so the figure on screen cannot drift from the figure inside.
		return {
			size,
			path,
			amountFormatted: formatAmount(amount, currency, { code: false })
		} satisfies ReceivingQrView;
	} catch {
		// A code is an extra route to a transfer the details already describe. Losing
		// it must never cost the payer the account number underneath.
		return null;
	}
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
