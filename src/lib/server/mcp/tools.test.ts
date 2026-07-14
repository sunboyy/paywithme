// Unit tests for the tool registry, the ADR-0002 scope filter, and the
// `tools/call` dispatcher.
//
// The registry currently holds ONE tool, so the scope FILTER is proved against a
// synthetic registry that also contains a write tool — that is the surface #32
// lands on, and it must already be correct. `list_groups` itself is driven through
// the real dispatcher with `listGroupsForUser` mocked, so the mapping (and the
// dropped internal `deletedAt`) is asserted on what an agent would actually see.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { GroupAccessError } from '$lib/server/groups';
import { scopeToPermissions } from '$lib/server/api/scope';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const { listGroupsForUser, consumeRateLimit } = vi.hoisted(() => ({
	listGroupsForUser: vi.fn(),
	consumeRateLimit: vi.fn()
}));

vi.mock('$lib/server/groups', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/groups')>()),
	listGroupsForUser
}));
vi.mock('$lib/server/api/rate-limit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/api/rate-limit')>()),
	consumeRateLimit
}));

// Imported AFTER the mocks are registered.
import { MCP_TOOLS, dispatchToolCall, filterToolsByScope, findTool, registerTool } from './tools';
import type { McpToolResult, RegisteredTool } from './types';

/** A principal holding a key of the given scope. */
function principalWith(scope: 'read' | 'write'): ApiKeyPrincipal {
	return {
		keyId: 'key_1',
		name: 'test key',
		userId: 'user_1',
		permissions: scopeToPermissions(scope)
	};
}

/** The envelope inside an `isError` result. */
function envelopeOf(result: McpToolResult): { code: string; message: string; details?: unknown } {
	return JSON.parse(result.content[0].text).error;
}

/** A synthetic write tool — the shape #32 will add (ADR-0002). */
const settleUpSpy = vi.fn();
const fakeWriteTool: RegisteredTool = registerTool({
	scope: 'write',
	rateLimitClass: 'write',
	args: z.strictObject({ groupId: z.string() }),
	definition: {
		name: 'settle_up',
		title: 'Settle up',
		description: 'Move money.',
		inputSchema: { type: 'object', properties: { groupId: { type: 'string' } } },
		annotations: {
			title: 'Settle up',
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false
		}
	},
	run: settleUpSpy
});

const REGISTRY_WITH_WRITE: RegisteredTool[] = [...MCP_TOOLS, fakeWriteTool];

const allowed = { allowed: true, count: 1, lastRequest: Date.now(), retryAfterMs: 0 };

beforeEach(() => {
	vi.clearAllMocks();
	consumeRateLimit.mockResolvedValue(allowed);
	settleUpSpy.mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
});

describe('the shipped registry (#28)', () => {
	it('exposes `list_groups` as a READ tool with the annotations Claude requires', () => {
		const tool = findTool('list_groups');
		expect(tool).toBeDefined();
		expect(tool?.scope).toBe('read');
		expect(tool?.rateLimitClass).toBe('read');
		expect(tool?.definition.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false
		});
		expect(tool?.definition.inputSchema).toMatchObject({ type: 'object' });
	});

	it('ships NO write tools yet — every tool is read-only (#28 is the read tracer bullet)', () => {
		for (const tool of MCP_TOOLS) {
			expect(tool.scope).toBe('read');
			expect(tool.definition.annotations.readOnlyHint).toBe(true);
		}
	});
});

describe('filterToolsByScope (ADR-0002)', () => {
	it('a READ key is never SHOWN a write tool — it cannot form the intent to call it', () => {
		const names = filterToolsByScope('read', REGISTRY_WITH_WRITE).map((t) => t.name);
		expect(names).toContain('list_groups');
		expect(names).not.toContain('settle_up');
	});

	it('a WRITE key sees everything (write ⊇ read)', () => {
		const names = filterToolsByScope('write', REGISTRY_WITH_WRITE).map((t) => t.name);
		expect(names).toEqual(['list_groups', 'settle_up']);
	});
});

describe('dispatchToolCall', () => {
	it('an UNKNOWN tool is a JSON-RPC protocol error (-32602), not a tool result', async () => {
		const outcome = await dispatchToolCall({ name: 'no_such_tool' }, principalWith('read'));

		expect(outcome.kind).toBe('protocol_error');
		if (outcome.kind !== 'protocol_error') throw new Error('expected a protocol error');
		expect(outcome.error.code).toBe(-32602);
		expect(outcome.error.message).toMatch(/unknown tool: no_such_tool/i);
	});

	it('a READ key calling a WRITE tool gets forbidden_scope — and burns NO rate budget', async () => {
		const outcome = await dispatchToolCall(
			{ name: 'settle_up', arguments: { groupId: 'grp_1' } },
			principalWith('read'),
			REGISTRY_WITH_WRITE
		);

		// A TOOL RESULT (the agent can read it), not a protocol error (ADR-0009).
		expect(outcome.kind).toBe('result');
		if (outcome.kind !== 'result') throw new Error('expected a result');
		expect(outcome.result.isError).toBe(true);
		expect(envelopeOf(outcome.result).code).toBe('forbidden_scope');
		// Defence in depth: the tool never ran, and a denied call costs no budget.
		expect(settleUpSpy).not.toHaveBeenCalled();
		expect(consumeRateLimit).not.toHaveBeenCalled();
	});

	it('a WRITE key may call the write tool (write ⊇ read)', async () => {
		const outcome = await dispatchToolCall(
			{ name: 'settle_up', arguments: { groupId: 'grp_1' } },
			principalWith('write'),
			REGISTRY_WITH_WRITE
		);

		expect(outcome.kind).toBe('result');
		expect(settleUpSpy).toHaveBeenCalledOnce();
		expect(consumeRateLimit).toHaveBeenCalledWith('key_1', 'write');
	});

	it('consumes the READ-class tier-2 counter for a read tool (§16.7)', async () => {
		listGroupsForUser.mockResolvedValue([]);
		await dispatchToolCall({ name: 'list_groups' }, principalWith('read'));

		expect(consumeRateLimit).toHaveBeenCalledWith('key_1', 'read');
	});

	it('an exhausted counter is a rate_limited RESULT that says NOT to retry now', async () => {
		consumeRateLimit.mockResolvedValue({
			allowed: false,
			count: 101,
			lastRequest: Date.now(),
			retryAfterMs: 12_400
		});

		const outcome = await dispatchToolCall({ name: 'list_groups' }, principalWith('read'));
		if (outcome.kind !== 'result') throw new Error('expected a result');

		expect(outcome.result.isError).toBe(true);
		const envelope = envelopeOf(outcome.result);
		expect(envelope.code).toBe('rate_limited');
		expect(envelope.message).toMatch(/do not retry immediately/i);
		expect(envelope.details).toEqual({
			scope: 'read',
			limit: 100,
			windowSeconds: 60,
			retryAfterSeconds: 13 // ceil(12.4s)
		});
		// The tool never ran.
		expect(listGroupsForUser).not.toHaveBeenCalled();
	});

	it('BAD ARGUMENTS are a self-correctable validation_error, not a protocol error', async () => {
		const outcome = await dispatchToolCall(
			// `list_groups` takes no arguments and its schema is strict.
			{ name: 'list_groups', arguments: { userId: 'someone-else' } },
			principalWith('read')
		);

		expect(outcome.kind).toBe('result');
		if (outcome.kind !== 'result') throw new Error('expected a result');
		expect(envelopeOf(outcome.result).code).toBe('validation_error');
		expect(listGroupsForUser).not.toHaveBeenCalled();
	});

	it('a service THROW becomes an isError result, never an escaped exception', async () => {
		listGroupsForUser.mockRejectedValue(new GroupAccessError());

		const outcome = await dispatchToolCall({ name: 'list_groups' }, principalWith('read'));
		if (outcome.kind !== 'result') throw new Error('expected a result');

		expect(outcome.result.isError).toBe(true);
		expect(envelopeOf(outcome.result).code).toBe('not_found');
	});
});

describe('list_groups', () => {
	it('returns the CALLER’s groups, projected through the /api/v1 DTO mapper', async () => {
		listGroupsForUser.mockResolvedValue([
			{
				id: 'grp_1',
				name: 'Trip',
				settlementCurrency: 'USD',
				createdBy: 'user_1',
				createdAt: new Date('2026-07-01T10:00:00.000Z'),
				// An INTERNAL field that must never reach an agent.
				deletedAt: null
			}
		]);

		const outcome = await dispatchToolCall({ name: 'list_groups' }, principalWith('read'));
		if (outcome.kind !== 'result') throw new Error('expected a result');

		// Resolved through the real service, for the KEY's owner — never a caller-supplied id.
		expect(listGroupsForUser).toHaveBeenCalledWith('user_1');
		expect(outcome.result.isError).toBeUndefined();
		expect(outcome.result.structuredContent).toEqual({
			groups: [
				{
					id: 'grp_1',
					name: 'Trip',
					settlementCurrency: 'USD',
					createdBy: 'user_1',
					createdAt: '2026-07-01T10:00:00.000Z'
				}
			]
		});
		// The internal soft-delete marker is dropped on the wire.
		expect(outcome.result.content[0].text).not.toContain('deletedAt');
	});
});
