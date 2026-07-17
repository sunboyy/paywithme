// The agent-facing GROUP view (ADR-0006).
//
// Not `GroupDto`. The differences are the whole point of the view layer:
//   - `name` is MEMBER-AUTHORED TEXT → it crosses the wire inside the untrusted
//     envelope, attributed to the user who created the group (ADR-0003). REST
//     serves it as a bare string, and must keep doing so: its consumers are
//     programs, which do not follow instructions they read.
//   - the internal `deletedAt` is absent, exactly as in REST (a deleted group is
//     never served at all).
//
// `createdBy` is not carried as a separate field: the group name's `author` already
// says who created the group, in the one place where knowing it MATTERS.

import type { CurrencyCode } from '$lib/money';
import type { Group } from '$lib/server/groups';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import { authorOf, untrusted, type UntrustedText } from './untrusted';

/** A group as an agent sees it. */
export interface GroupView {
	readonly id: string;
	/** Written by whoever created the group — UNTRUSTED (ADR-0003). */
	readonly name: UntrustedText;
	/** The currency every balance and settlement figure in this group is in. */
	readonly settlementCurrency: CurrencyCode;
	/** Creation time, ISO-8601. */
	readonly createdAt: string;
}

/** Project a `Group` read model into the agent-facing view. PURE. */
export function toGroupView(group: Group, principal: ApiKeyPrincipal): GroupView {
	return {
		id: group.id,
		name: untrusted(group.name, authorOf(group.createdBy, principal)),
		settlementCurrency: group.settlementCurrency as CurrencyCode,
		createdAt: group.createdAt.toISOString()
	};
}
