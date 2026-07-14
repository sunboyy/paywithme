// Unit tests for the MCP error contract (ADR-0009).
//
// The two channels are asserted separately, because confusing them is the bug the
// ADR exists to prevent: AUTH is an HTTP `401` carrying `WWW-Authenticate` (Claude
// ignores that header on a `200`), while a DOMAIN failure is an `isError: true`
// tool RESULT the agent can read and self-correct from. The 404-conflation
// invariant gets its own test: "not yours" and "does not exist" must be
// BYTE-IDENTICAL, or we have shipped an existence oracle.

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { GroupAccessError } from '$lib/server/groups';
import { TransactionCursorError, TransactionNotFoundError } from '$lib/server/transactions';
import {
	RESOURCE_METADATA_PATH,
	mapToolError,
	mcpForbiddenOrigin,
	mcpMethodNotAllowed,
	mcpRateLimited,
	mcpRateLimitedResult,
	mcpUnauthorized,
	toolError,
	toolSuccess
} from './errors';
import type { McpToolResult } from './types';

/** The envelope an `isError` result carries, parsed back out of its text content. */
function envelopeOf(result: McpToolResult): { code: string; message: string; details?: unknown } {
	return JSON.parse(result.content[0].text).error;
}

describe('mcpUnauthorized (ADR-0009: auth failures live at the HTTP layer)', () => {
	it('is a 401 with the WWW-Authenticate resource_metadata pointer', async () => {
		const res = mcpUnauthorized('https://paywithme.example.com');

		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="https://paywithme.example.com${RESOURCE_METADATA_PATH}"`
		);
		expect(res.headers.get('content-type')).toBe('application/json');
		// The SAME generic body `/api/v1` emits — no enumeration signal.
		expect(await res.json()).toEqual({
			error: { code: 'unauthorized', message: 'Authentication required.' }
		});
	});

	it('points at the LIVE origin, so dev / preview / prod each self-describe', () => {
		expect(mcpUnauthorized('http://localhost:5173').headers.get('www-authenticate')).toContain(
			'http://localhost:5173/.well-known/oauth-protected-resource'
		);
	});
});

describe('transport-level responses', () => {
	it('mcpMethodNotAllowed is a 405 advertising POST (ADR-0001: no SSE on GET)', async () => {
		const res = mcpMethodNotAllowed();
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('POST');
		expect((await res.json()).error.code).toBe('bad_request');
	});

	it('mcpForbiddenOrigin is a 403', async () => {
		const res = mcpForbiddenOrigin();
		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toMatch(/origin is not allowed/i);
	});

	it('mcpRateLimited (tier-1 backstop) is a 429 with Retry-After', async () => {
		const res = mcpRateLimited(42);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('42');
		expect((await res.json()).error.code).toBe('rate_limited');
	});
});

describe('toolSuccess / toolError (ADR-0009: domain errors are tool RESULTS)', () => {
	it('a success carries the payload as text AND structured content, with no isError', () => {
		const result = toolSuccess({ groups: [{ id: 'grp_1' }] });

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({ groups: [{ id: 'grp_1' }] });
		expect(JSON.parse(result.content[0].text)).toEqual({ groups: [{ id: 'grp_1' }] });
	});

	it('an error reuses the EXISTING /api/v1 envelope code verbatim', () => {
		const result = toolError('validation_error', undefined, { fieldErrors: { amount: ['bad'] } });

		expect(result.isError).toBe(true);
		expect(envelopeOf(result)).toMatchObject({
			code: 'validation_error',
			details: { fieldErrors: { amount: ['bad'] } }
		});
	});

	it('forbidden_scope tells the agent NOT to retry and to ask for a write key', () => {
		const message = envelopeOf(toolError('forbidden_scope')).message;
		expect(message).toMatch(/do not retry/i);
		expect(message).toMatch(/write key/i);
	});

	it('rate_limited tells the agent NOT to retry immediately', () => {
		const result = mcpRateLimitedResult('read', 100, 60, 17);
		const envelope = envelopeOf(result);

		expect(result.isError).toBe(true);
		expect(envelope.code).toBe('rate_limited');
		expect(envelope.message).toMatch(/do not retry immediately/i);
		expect(envelope.details).toEqual({
			scope: 'read',
			limit: 100,
			windowSeconds: 60,
			retryAfterSeconds: 17
		});
	});
});

describe('mapToolError', () => {
	it('CONFLATES "not yours" with "does not exist" — no existence oracle', () => {
		const noAccess = mapToolError(new GroupAccessError());
		const absent = mapToolError(new TransactionNotFoundError());

		// Byte-identical: an id-probing agent cannot tell the two apart.
		expect(noAccess).toEqual(absent);
		expect(envelopeOf(noAccess).code).toBe('not_found');
		// And the message must not hint at the difference either.
		expect(envelopeOf(noAccess).message).toBe('The requested resource was not found.');
	});

	it('maps a bad pagination cursor to bad_request', () => {
		expect(envelopeOf(mapToolError(new TransactionCursorError())).code).toBe('bad_request');
	});

	it('maps a ZodError to a self-correctable validation_error with field details', () => {
		const schema = z.strictObject({ groupId: z.string() });
		const parsed = schema.safeParse({ nope: 1 });
		if (parsed.success) throw new Error('expected a parse failure');

		const envelope = envelopeOf(mapToolError(parsed.error));
		expect(envelope.code).toBe('validation_error');
		expect(envelope.details).toMatchObject({ fieldErrors: expect.any(Object) });
	});

	it('collapses an UNKNOWN throw to an opaque internal_error — nothing leaks', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const envelope = envelopeOf(mapToolError(new Error('connection string: postgres://secret')));

		expect(envelope.code).toBe('internal_error');
		expect(JSON.stringify(envelope)).not.toContain('secret');
		spy.mockRestore();
	});

	it('never THROWS — a domain error must not become a protocol error (ADR-0009)', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => mapToolError('a bare string')).not.toThrow();
		expect(mapToolError(undefined).isError).toBe(true);
		spy.mockRestore();
	});
});
