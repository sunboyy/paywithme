// Real-DB HTTP-BOUNDARY integration tests for the `/mcp` Connector (issue #28).
//
// The tracer bullet, end to end: a real `Request` with a real
// `Authorization: Bearer <key>` → the REAL `/mcp` route → the REAL `verifyApiKey`
// against the REAL `api_key` table → the REAL `lib/server` services → the LOCAL
// Postgres. Nothing is mocked, so a break in ANY layer fails here. The user story
// under test is the ticket's: *"what groups am I in?"*, answered from the database.
//
// The acceptance criteria, in order:
//
//   1. TRANSPORT  — `initialize` / `tools/list` / `tools/call` over one POST;
//      `GET` → 405; `application/json`, never `text/event-stream`; and NO
//      `Mcp-Session-Id` is ever issued (ADR-0001: stateless).
//   2. AUTH       — missing / invalid / expired / revoked all collapse to the SAME
//      401 carrying `WWW-Authenticate: Bearer resource_metadata="…"` (ADR-0009).
//   3. ORIGIN     — validated on every request (the spec's DNS-rebinding MUST).
//   4. SCOPE      — `tools/list` is scope-filtered (ADR-0002); #28 ships read tools
//      only, so a read key and a write key see the same list — and it is all
//      `readOnlyHint`.
//   5. NO ORACLE  — another user's group is not "denied", it is ABSENT. Identical
//      to a group that does not exist (ADR-0009's conflation rule).
//   6. RATE LIMIT — the tier-2 READ counter (100/60s), the SAME one `/api/v1`
//      consumes, surfaced as an `isError` `rate_limited` result (ADR-0009).
//
// Cleanup mirrors the `/api/v1` suite: `cleanupApiKeyRows()` then
// `cleanupSuiteRows()`. A second consecutive run is green.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '$lib/server/api/rate-limit';
import { createGroup } from '$lib/server/groups';
import { MCP_PROTOCOL_VERSION } from '$lib/server/mcp/protocol';
import { cleanupSuiteRows, createTestUser, describeIntegration } from './helpers';
import { cleanupApiKeyRows, expireApiKey, mintApiKey, revokeApiKey } from './api-client';
import { createApiScenario, SETTLEMENT_CURRENCY, type ApiScenario } from './api-fixtures';
import {
	MCP_ORIGIN,
	mcpNotify,
	mcpRequest,
	mcpRpc,
	mcpToolCall,
	toolErrorEnvelope,
	type ToolResultWire
} from './mcp-client';

/** The ONE 401 body the Connector may ever emit (no enumeration signal). */
const GENERIC_401 = { error: { code: 'unauthorized', message: 'Authentication required.' } };

/** A group as `list_groups` puts it on the wire. */
interface GroupWire {
	id: string;
	name: string;
	settlementCurrency: string;
	createdBy: string;
	createdAt: string;
}

describeIntegration('integration: /mcp Connector HTTP boundary (issue #28)', () => {
	let s: ApiScenario;
	/** The read key's `Authorization` value — the one a user pastes into Claude Code. */
	let read: { key: string };

	beforeEach(async () => {
		s = await createApiScenario('mcp');
		read = { key: s.readKey.key };
	});

	afterEach(async () => {
		await cleanupApiKeyRows();
		await cleanupSuiteRows();
	});

	/** The groups `list_groups` returns for a key. */
	async function listGroups(key: string): Promise<GroupWire[]> {
		const res = await mcpToolCall('list_groups', undefined, { key });
		expect(res.status).toBe(200);
		expect(res.body.result?.isError).toBeUndefined();
		return (res.body.result?.structuredContent?.groups ?? []) as GroupWire[];
	}

	// ── 1. TRANSPORT (ADR-0001) ────────────────────────────────────────────────

	describe('transport', () => {
		it('initialize → capabilities + serverInfo, as JSON, with NO session id', async () => {
			const res = await mcpRpc<{
				protocolVersion: string;
				capabilities: Record<string, unknown>;
				serverInfo: { name: string };
			}>('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} }, read);

			expect(res.status).toBe(200);
			expect(res.body.result).toMatchObject({
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'paywithme' }
			});

			// Stateless (ADR-0001): no session is ever minted, so no client can be
			// asked to pin one — and no serverless invocation needs to remember one.
			expect(res.headers.get('mcp-session-id')).toBeNull();
			// JSON, never a stream.
			expect(res.headers.get('content-type')).toBe('application/json');
			expect(res.headers.get('content-type')).not.toContain('text/event-stream');
		});

		it('GET → 405 (no SSE stream to open; we have no server-initiated messages)', async () => {
			const res = await mcpRequest<{ error: { code: string } }>('GET', undefined, read);

			expect(res.status).toBe(405);
			expect(res.headers.get('allow')).toBe('POST');
		});

		it('DELETE (a session teardown) → 405: there is no session to delete', async () => {
			expect((await mcpRequest('DELETE', undefined, read)).status).toBe(405);
		});

		it('`notifications/initialized` is acknowledged with 202 and an empty body', async () => {
			const res = await mcpNotify('notifications/initialized', read);

			expect(res.status).toBe(202);
			expect(res.body).toBeUndefined();
		});

		it('an unknown method → JSON-RPC -32601 (on a 200: the transport is fine)', async () => {
			const res = await mcpRpc('resources/list', undefined, read);

			expect(res.status).toBe(200);
			expect(res.body.error?.code).toBe(-32601);
		});

		it('malformed JSON → 400 parse_error with a null id', async () => {
			const res = await mcpRequest<{ id: null; error: { code: number } }>('POST', undefined, {
				...read,
				raw: '{ oops'
			});

			expect(res.status).toBe(400);
			expect(res.body.id).toBeNull();
			expect(res.body.error.code).toBe(-32700);
		});
	});

	// ── 2. AUTH (ADR-0009) ─────────────────────────────────────────────────────

	describe('auth', () => {
		/** Every failure mode must be indistinguishable from the others. */
		async function expect401(options: Parameters<typeof mcpRpc>[2]) {
			const res = await mcpRpc('tools/list', undefined, options);

			expect(res.status).toBe(401);
			expect(res.body).toEqual(GENERIC_401);
			// The pointer Claude needs — and which it ignores on a 200 (ADR-0009).
			expect(res.headers.get('www-authenticate')).toBe(
				`Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource"`
			);
		}

		it('a MISSING Authorization header → 401', async () => {
			await expect401({});
		});

		it('a MALFORMED Authorization header → 401', async () => {
			await expect401({ headers: { authorization: 'Basic zzz' } });
		});

		it('an INVALID key → 401', async () => {
			await expect401({ key: 'pwm_not_a_real_key' });
		});

		it('an EXPIRED key → 401', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'expired');
			await expireApiKey(key.id);
			await expect401({ key: key.key });
		});

		it('a REVOKED key → 401 — and it can no longer read the groups it once could', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'doomed');
			// It works …
			expect(await listGroups(key.key)).toHaveLength(1);
			// … until it is revoked.
			await revokeApiKey(key.id);
			await expect401({ key: key.key });
		});
	});

	// ── 3. ORIGIN (the spec's DNS-rebinding MUST) ──────────────────────────────

	describe('Origin validation', () => {
		it('rejects a foreign Origin with a 403, even holding a VALID key', async () => {
			const res = await mcpRpc('tools/list', undefined, {
				...read,
				origin: 'https://evil.example'
			});

			expect(res.status).toBe(403);
		});

		it('accepts the app’s own Origin', async () => {
			const res = await mcpRpc('tools/list', undefined, { ...read, origin: MCP_ORIGIN });
			expect(res.status).toBe(200);
		});

		it('accepts an ABSENT Origin — Claude Code and Cursor are not browsers', async () => {
			const res = await mcpRpc('tools/list', undefined, read);
			expect(res.status).toBe(200);
		});
	});

	// ── 4. TOOL SURFACE (ADR-0002) ─────────────────────────────────────────────

	describe('tools/list', () => {
		it('advertises `list_groups` to a read key, with the annotations Claude requires', async () => {
			const res = await mcpRpc<{
				tools: { name: string; description: string; annotations: Record<string, boolean> }[];
			}>('tools/list', undefined, read);

			expect(res.status).toBe(200);
			const tools = res.body.result?.tools ?? [];
			expect(tools.map((t) => t.name)).toContain('list_groups');

			const listGroupsTool = tools.find((t) => t.name === 'list_groups');
			expect(listGroupsTool?.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false
			});
			expect(listGroupsTool?.description).toBeTruthy();
		});

		it('#28 advertises NO tool that can move money — to EITHER key', async () => {
			for (const key of [s.readKey.key, s.writeKey.key]) {
				const res = await mcpRpc<{ tools: { annotations: { readOnlyHint: boolean } }[] }>(
					'tools/list',
					undefined,
					{ key }
				);
				const tools = res.body.result?.tools ?? [];
				expect(tools.length).toBeGreaterThan(0);
				expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
			}
		});
	});

	// ── 5. list_groups — the answer, from the database ─────────────────────────

	describe('tools/call list_groups', () => {
		it('answers "what groups am I in?" from the real DB', async () => {
			const groups = await listGroups(read.key);

			expect(groups).toHaveLength(1);
			expect(groups[0]).toMatchObject({
				id: s.group.id,
				name: s.group.name,
				settlementCurrency: SETTLEMENT_CURRENCY,
				createdBy: s.user.id
			});
			// The internal soft-delete marker never reaches the wire (`toGroupDto`).
			expect(groups[0]).not.toHaveProperty('deletedAt');
			expect(typeof groups[0].createdAt).toBe('string');
		});

		it('the text content mirrors the structured content, so any client can read it', async () => {
			const res = await mcpToolCall('list_groups', undefined, read);
			const result = res.body.result as ToolResultWire;

			expect(result.content[0].type).toBe('text');
			expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
		});

		it('returns EVERY group the caller is in, and only those', async () => {
			const second = await createGroup({
				userId: s.user.id,
				userName: s.user.name,
				name: 'second group',
				settlementCurrency: SETTLEMENT_CURRENCY
			});

			const ids = (await listGroups(read.key)).map((g) => g.id);
			expect(ids.sort()).toEqual([s.group.id, second.id].sort());
		});

		it('NO EXISTENCE ORACLE: another user’s group is ABSENT, not denied', async () => {
			const stranger = await createTestUser('mcpstranger');
			const theirs = await createGroup({
				userId: stranger.id,
				userName: stranger.name,
				name: 'not yours',
				settlementCurrency: SETTLEMENT_CURRENCY
			});

			const res = await mcpToolCall('list_groups', undefined, read);

			// A successful call that simply does not mention it — byte-identical to what
			// the caller would see if the group had never been created. No 403, no hint.
			expect(res.body.result?.isError).toBeUndefined();
			const ids = ((res.body.result?.structuredContent?.groups ?? []) as GroupWire[]).map(
				(g) => g.id
			);
			expect(ids).not.toContain(theirs.id);
			expect(JSON.stringify(res.body)).not.toContain(theirs.id);
		});

		it('an unknown tool is a JSON-RPC -32602, not an isError result', async () => {
			const res = await mcpToolCall('drop_database', undefined, read);

			expect(res.status).toBe(200);
			expect(res.body.error?.code).toBe(-32602);
			expect(res.body.result).toBeUndefined();
		});

		it('a hallucinated ARGUMENT is a self-correctable validation_error tool result', async () => {
			const res = await mcpToolCall('list_groups', { userId: 'someone-else' }, read);

			// A tool RESULT (the agent can read it and retry correctly), not a protocol error.
			expect(res.status).toBe(200);
			expect(res.body.result?.isError).toBe(true);
			expect(toolErrorEnvelope(res.body.result).error.code).toBe('validation_error');
		});
	});

	// ── 6. RATE LIMITING (§16.7 tier-2, surfaced per ADR-0009) ─────────────────

	describe('rate limiting', () => {
		it('the READ window (100/60s) allows the 100th call and limits the 101st', async () => {
			// Its own key, so the counters can't bleed in from the other tests.
			const key = await mintApiKey(s.user.id, 'read', 'mcp burst');
			const max = RATE_LIMITS.read.max;
			expect(max).toBe(100);

			for (let i = 1; i <= max; i++) {
				const res = await mcpToolCall('list_groups', undefined, { key: key.key });
				expect(res.body.result?.isError, `call ${i} of ${max} must be allowed`).toBeUndefined();
			}

			const limited = await mcpToolCall('list_groups', undefined, { key: key.key });

			// ADR-0009: a 429 is a DOMAIN error → an `isError` result the agent reads,
			// carrying explicit "do not retry now" guidance. NOT a broken transport.
			expect(limited.status).toBe(200);
			expect(limited.body.result?.isError).toBe(true);

			const envelope = toolErrorEnvelope(limited.body.result).error;
			expect(envelope.code).toBe('rate_limited');
			expect(envelope.message).toMatch(/do not retry immediately/i);
			expect(envelope.details).toEqual({
				scope: 'read',
				limit: 100,
				windowSeconds: 60,
				retryAfterSeconds: expect.any(Number)
			});
		});

		it('`tools/list` does not consume the read budget — only real work does', async () => {
			const key = await mintApiKey(s.user.id, 'read', 'listing');

			// A hundred tool LISTINGS …
			for (let i = 0; i < 100; i++) {
				await mcpRpc('tools/list', undefined, { key: key.key });
			}
			// … leave the read budget untouched.
			const res = await mcpToolCall('list_groups', undefined, { key: key.key });
			expect(res.body.result?.isError).toBeUndefined();
		});
	});
});
