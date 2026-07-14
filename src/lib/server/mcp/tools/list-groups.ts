// `list_groups` — the Connector's first tool (issue #28).
//
// "What groups am I in?" It calls `listGroupsForUser` DIRECTLY (ADR-0001: the MCP
// layer does not proxy our own REST API over HTTP to itself) and projects each row
// through the SAME owned `toGroupDto` mapper `/api/v1` uses, so the internal
// `deletedAt` never reaches an agent and the two surfaces cannot drift.
//
// NO EXISTENCE ORACLE: `listGroupsForUser` returns only groups the caller has an
// ACTIVE member link to. A group the key cannot see is therefore not "denied" — it
// is simply absent, which is exactly what an absent group looks like (ADR-0009's
// conflation rule, upheld here by construction rather than by a check).
//
// Takes no arguments: the caller is the key's owner, and asking an agent to pass a
// user id would invite it to pass someone else's.

import { z } from 'zod';
import { listGroupsForUser } from '$lib/server/groups';
import { toGroupDto } from '$lib/server/api/v1';
import { toolSuccess } from '../errors';
import type { McpTool } from '../types';

/** No arguments. `strict()` so a hallucinated argument is a loud validation error. */
const listGroupsArgs = z.strictObject({});

export const listGroupsTool: McpTool<z.infer<typeof listGroupsArgs>> = {
	scope: 'read',
	rateLimitClass: 'read',
	args: listGroupsArgs,
	definition: {
		name: 'list_groups',
		title: 'List groups',
		description:
			'List every shared-expense group the current user belongs to, newest first. ' +
			'Returns each group id, name, settlement currency and creation time. Start here: ' +
			'every other tool needs a group id.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false
		},
		annotations: {
			title: 'List groups',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async ({ principal }) => {
		const groups = await listGroupsForUser(principal.userId);
		return toolSuccess({ groups: groups.map(toGroupDto) });
	}
};
