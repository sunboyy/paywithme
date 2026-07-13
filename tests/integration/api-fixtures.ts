// Shared fixtures for the `/api/v1` boundary suites (issue #25; PLAN §16.10).
//
// One scenario every API suite starts from: a user, a group they own (USD
// settlement), a second member, and BOTH a `read` and a `write` API key for that
// user. The group/members are seeded through the REAL services (so the rows are
// exactly what the web app would have written) and the keys through the REAL
// better-auth plugin — the suites then only ever touch the app through
// `apiCall`.

import { createGroup, type Group } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import { members as membersTable } from '$lib/server/db/groups-schema';
import { categoriesFor } from '$lib/categories';
import { and, eq } from 'drizzle-orm';
import { createTestUser, db } from './helpers';
import { mintApiKey, type TestApiKey } from './api-client';

/** A spending category id from the seeded set (migration 4.3). */
export const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

/** The category every settle-up Transfer is recorded under (PLAN §8.4 / §16.4). */
export const DEBT_SETTLEMENT_CATEGORY = 'transfer-debt-settlement';

/** The settlement currency every fixture group uses. */
export const SETTLEMENT_CURRENCY = 'USD';

export interface ApiScenario {
	user: { id: string; name: string };
	group: Group;
	/** The creator's own member row id. */
	alice: string;
	/** A second, unlinked member. */
	bob: string;
	readKey: TestApiKey;
	writeKey: TestApiKey;
}

/** The creator's active member id in a group. */
export async function creatorMemberId(groupId: string, userId: string): Promise<string> {
	const [row] = await db
		.select({ id: membersTable.id })
		.from(membersTable)
		.where(and(eq(membersTable.groupId, groupId), eq(membersTable.userId, userId)));
	return row.id;
}

/** Seed the standard scenario: user + group + 2 members + a read key and a write key. */
export async function createApiScenario(label = 'api'): Promise<ApiScenario> {
	const user = await createTestUser(label);
	const group = await createGroup({
		userId: user.id,
		userName: user.name,
		name: `${label} group`,
		settlementCurrency: SETTLEMENT_CURRENCY
	});
	const alice = await creatorMemberId(group.id, user.id);
	const bob = (await addMember({ userId: user.id, groupId: group.id, displayName: 'Bob' })).id;
	const readKey = await mintApiKey(user.id, 'read', 'reader');
	const writeKey = await mintApiKey(user.id, 'write', 'writer');
	return { user, group, alice, bob, readKey, writeKey };
}

/**
 * A VALID equal-split spending input in the group's settlement currency (rate 1, so
 * the §7.6 settlement total is trivially `amountTotal`). Money is integer minor units.
 */
export function spendingInput({
	payerId,
	beneficiaryIds,
	amount = 9000,
	title = 'Dinner'
}: {
	payerId: string;
	beneficiaryIds: string[];
	amount?: number;
	title?: string;
}) {
	return {
		type: 'spending' as const,
		title,
		categoryId: SPENDING_CATEGORY,
		amountTotal: amount,
		currency: SETTLEMENT_CURRENCY,
		exchangeRate: '1',
		amountTotalSettlement: amount,
		splitMode: 'equal' as const,
		payers: [{ memberId: payerId, amountPaid: amount }],
		beneficiaries: beneficiaryIds.map((memberId) => ({ memberId })),
		items: [],
		charges: []
	};
}
