// Argument schemas shared by the Connector's tools.
//
// Two rules, both load-bearing:
//
//   - IDS ONLY, NEVER NAMES (ADR-0006). No tool takes a group or member NAME. The
//     server does no fuzzy matching in the money path — an agent matching "Nan"
//     against `Nan Suphaporn` and `Nanthawat P.` must do it ITSELF, visibly, in the
//     transcript, where the user can see the reasoning and catch a wrong pick. That
//     starts here, on the READ tools, because the ids a write tool takes are the ids
//     these tools hand out.
//
//   - `strictObject`, so a hallucinated argument (`{ userId: 'someone-else' }`) is a
//     loud `validation_error` tool result the agent can self-correct against — never
//     a silently-ignored key.
//
// A `ZodError` thrown by any of these is caught by the dispatcher and mapped to the
// ADR-0009 `validation_error` result, with the offending field named.

import { z } from 'zod';

/** The group id every group-scoped tool takes. */
export const groupIdArg = z.string().min(1, 'A group id is required. Call `list_groups` first.');

/** The JSON-Schema fragment describing that same argument to the model. */
export const GROUP_ID_PROPERTY = {
	type: 'string',
	description: 'The group id, exactly as returned by `list_groups`. Never a group name.'
} as const;

/** Arguments for a tool that operates on one group. */
export const groupArgs = z.strictObject({ groupId: groupIdArg });

/** The `inputSchema` for a tool that takes only a group id. */
export const GROUP_INPUT_SCHEMA = {
	type: 'object',
	properties: { groupId: GROUP_ID_PROPERTY },
	required: ['groupId'],
	additionalProperties: false
} as const;

/** The `inputSchema` for a tool that takes no arguments at all. */
export const NO_INPUT_SCHEMA = {
	type: 'object',
	properties: {},
	additionalProperties: false
} as const;
