// `get_balances` — the SINGLE AUTHORITATIVE answer to "how much do I owe?"
// (issue #29; ADR-0008).
//
// The figures come from `getGroupBalances` — the same §8.1 computation the web app
// renders: Σ paid − Σ owed per member, in the group's settlement currency, in integer
// minor units, over every NON-deleted transaction, with foreign-currency entries
// already converted at their recorded rate (§7.6). Nothing here re-derives or re-sums
// anything; the view only re-shapes (minor units → decimal strings, ADR-0004) and adds
// the caller's own line as a sentence to quote.
//
// The failure this tool exists to prevent needs no attacker and no bug: an agent that
// lists a page of transactions, adds them up, and confidently states a number that is
// wrong because there were 180 transactions and it saw 25. The tool DESCRIPTION and
// the payload's `_note` both say so, because by the time the model is looking at the
// data, the description is a long way up the context.

import { z } from 'zod';
import { getGroupBalances } from '$lib/server/balances';
import { toolSuccess } from '../errors';
import { toBalancesView } from '../view';
import type { McpTool } from '../types';
import { GROUP_INPUT_SCHEMA, groupArgs } from './args';
import { loadGroupView, loadMemberViews } from './load';

export const getBalancesTool: McpTool<z.infer<typeof groupArgs>> = {
	scope: 'read',
	rateLimitClass: 'read',
	args: groupArgs,
	definition: {
		name: 'get_balances',
		title: 'Get group balances',
		description:
			'THE authoritative answer to "how much do I owe / am I owed in this group?". ' +
			"Returns every member's net balance, computed SERVER-SIDE by paywithme in the " +
			"group's settlement currency, across every transaction — including ones you have " +
			"not seen. `you` holds the current user's own figure and a sentence you can quote. " +
			'ALWAYS call this for any owed amount. NEVER add up transactions to work one out ' +
			'yourself: transaction lists are paginated and currency-mixed and you WILL get the ' +
			'wrong number. Do not adjust, round, or convert what this returns.',
		inputSchema: GROUP_INPUT_SCHEMA,
		annotations: {
			title: 'Get group balances',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async ({ principal }, { groupId }) => {
		// The group carries the settlement currency the balance integers are denominated
		// in, AND is the access gate (absent / not-yours → the conflated `not_found`).
		const group = await loadGroupView(principal, groupId);
		const members = await loadMemberViews(principal, groupId);
		const balances = await getGroupBalances({ userId: principal.userId, groupId });

		return toolSuccess({ ...toBalancesView({ group, members, balances }) });
	}
};
