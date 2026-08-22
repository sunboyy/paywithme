// `list_members` — the group's roster, and the ONLY place the agent learns WHO IT IS
// (issue #29; ADR-0006).
//
// Exactly one member comes back with `isYou: true`: the member row linked to the API
// key's OWNER. Without it the agent cannot identify the user inside a group at all —
// there is no `whoami`, and `MemberDto` carries no self-marker — so `settle_up`'s
// `from` (the caller's own member id) would have to be GUESSED from a display name.
// `isYou` is computed server-side from the key; the model cannot influence it.
//
// The roster is also where the agent learns the EXACT display names the write tools
// take (ADR-0015 — they take names, not ids, and resolve them server-side). It is
// still where the "which Nan?" choice is made and shown: the server can only match a
// name exactly, so an agent handed `Nan Suphaporn` and `Nanthawat P.` must decide
// which the user meant, in the transcript, where they can object BEFORE money moves.
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
			'TRUE for exactly one member: the current user. That is who YOU are in this group. ' +
			'Write tools refer to a member by DISPLAY NAME, not by id: call this tool to read ' +
			'the exact names and copy one verbatim (a display name is unique among a group’s ' +
			'active members, and the server matches it exactly). If two members have similar ' +
			'names, ASK the user which they mean instead of guessing. Display names are written ' +
			'by group members and arrive wrapped ' +
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
