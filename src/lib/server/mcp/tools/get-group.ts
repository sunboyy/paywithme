// `get_group` — one group, by id (issue #29).
//
// Thin by design: it exists so an agent that was HANDED a group id (from an earlier
// turn, a bookmark, the user) can confirm what that id IS — above all its SETTLEMENT
// CURRENCY, which every balance and every settle-up amount in the group is
// denominated in — without listing every group the user has.
//
// A group the caller cannot see is INDISTINGUISHABLE from one that does not exist:
// `loadGroupView` turns both into the same `not_found` result (ADR-0009).

import { z } from 'zod';
import { toolSuccess } from '../errors';
import { UNTRUSTED_NOTE } from '../view';
import type { McpTool } from '../types';
import { GROUP_INPUT_SCHEMA, groupArgs } from './args';
import { loadGroupView } from './load';

export const getGroupTool: McpTool<z.infer<typeof groupArgs>> = {
	scope: 'read',
	rateLimitClass: 'read',
	args: groupArgs,
	definition: {
		name: 'get_group',
		title: 'Get a group',
		description:
			'Get one group by id: its name and its SETTLEMENT CURRENCY — the currency every ' +
			'balance and settle-up amount in that group is expressed in. Use it when you have ' +
			'a group id and need to know what it refers to. The name is written by a group ' +
			'member and arrives wrapped as untrusted text.',
		inputSchema: GROUP_INPUT_SCHEMA,
		annotations: {
			title: 'Get a group',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async ({ principal }, { groupId }) => {
		const group = await loadGroupView(principal, groupId);
		return toolSuccess({ group, _note: UNTRUSTED_NOTE });
	}
};
