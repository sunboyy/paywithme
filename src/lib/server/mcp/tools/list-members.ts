// `list_members` — the group's roster, and the ONLY place the agent learns WHO IT IS
// (issue #29; ADR-0006).
//
// Exactly one member comes back with `isYou: true`: the member row linked to the API
// key's OWNER. Without it the agent cannot identify the user inside a group at all —
// there is no `whoami`, and `MemberDto` carries no self-marker — so `settle_up`'s
// `from` (the caller's own member id) would have to be GUESSED from a display name.
// `isYou` is computed server-side from the key; the model cannot influence it.
//
// The roster is also the agent's NAME → ID map. Write tools take ids only (ADR-0006);
// the agent does the name matching itself, in the transcript, where the user can see
// "Nan" being resolved to one of two Nans and can object BEFORE money is recorded.
//
// Every display name is Member-authored text (ADR-0003) and arrives wrapped. Their
// author is `unknown`, honestly: the domain records nobody as the author of a member's
// name (anyone in the group can add a slot or rename one) — see `view/member.ts`.

import { z } from 'zod';
import { toolSuccess } from '../errors';
import { UNTRUSTED_NOTE } from '../view';
import type { McpTool } from '../types';
import { GROUP_INPUT_SCHEMA, groupArgs } from './args';
import { loadMemberViews } from './load';

export const listMembersTool: McpTool<z.infer<typeof groupArgs>> = {
	scope: 'read',
	rateLimitClass: 'read',
	args: groupArgs,
	definition: {
		name: 'list_members',
		title: 'List group members',
		description:
			'List everyone in a group. Each member has an id, a display name, and `isYou` — ' +
			'TRUE for exactly one member: the current user. That member id is who YOU are in ' +
			'this group; use it whenever a tool needs the current user as a payer or payee. ' +
			"Use this tool to turn a person's NAME into a member ID before any other tool that " +
			'takes one — and if two members have similar names, ASK the user which they mean ' +
			'instead of guessing. Display names are written by group members and arrive wrapped ' +
			'as untrusted text. `isActive: false` means the member was removed from the group: ' +
			'they still appear in past transactions and balances, but must not be given new ones.',
		inputSchema: GROUP_INPUT_SCHEMA,
		annotations: {
			title: 'List group members',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async ({ principal }, { groupId }) => {
		// Access-checked inside `listMembers` — no access is the conflated `not_found`.
		const members = await loadMemberViews(principal, groupId);
		return toolSuccess({ groupId, members, _note: UNTRUSTED_NOTE });
	}
};
