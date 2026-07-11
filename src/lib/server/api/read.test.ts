// Unit tests for the shared read-endpoint error translator (PLAN §16.4, §16.5).
//
// `mapReadError` is the ONE place `/api/v1` read routes turn `lib/server` DOMAIN
// errors into the stable §16.5 envelope, so it is unit-tested directly: the two
// not-found domain errors CONFLATE to a single 404 `not_found`; a bad cursor is a
// 400 `bad_request`; anything else collapses to an opaque 500 (never leaking).

import { describe, it, expect } from 'vitest';
import { mapReadError, withReadErrorHandling } from './read';
import { GroupAccessError } from '$lib/server/groups';
import { TransactionNotFoundError, TransactionCursorError } from '$lib/server/transactions';
import { error, redirect, type RequestHandler } from '@sveltejs/kit';

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

describe('mapReadError', () => {
	it('GroupAccessError → 404 not_found (no-access conflated with absent)', async () => {
		const { status, body } = await read(mapReadError(new GroupAccessError()));
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});

	it('TransactionNotFoundError → 404 not_found (same envelope as no-access)', async () => {
		const { status, body } = await read(mapReadError(new TransactionNotFoundError()));
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});

	it('the two not-found errors are indistinguishable on the wire (conflation)', async () => {
		const access = await read(mapReadError(new GroupAccessError()));
		const txn = await read(mapReadError(new TransactionNotFoundError()));
		expect(access).toEqual(txn);
	});

	it('TransactionCursorError → 400 bad_request (not 500, not silently ignored)', async () => {
		const { status, body } = await read(mapReadError(new TransactionCursorError()));
		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
	});

	it('an unknown throw collapses to an opaque 500 internal_error', async () => {
		const { status, body } = await read(mapReadError(new Error('boom: secret internals')));
		expect(status).toBe(500);
		expect(body.error.code).toBe('internal_error');
		// The original message is NEVER forwarded.
		expect(JSON.stringify(body)).not.toContain('secret internals');
	});

	it('maps a SvelteKit HttpError by its status (delegates to handleApiError)', async () => {
		let thrown: unknown;
		try {
			error(404, 'gone');
		} catch (e) {
			thrown = e;
		}
		const { status, body } = await read(mapReadError(thrown));
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});
});

describe('withReadErrorHandling', () => {
	it('returns the handler response untouched on success', async () => {
		const handler = withReadErrorHandling(
			(() => new Response('ok', { status: 200 })) as RequestHandler
		);
		const res = await handler({} as Parameters<RequestHandler>[0]);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});

	it('translates a thrown domain error into the envelope', async () => {
		const handler = withReadErrorHandling((() => {
			throw new GroupAccessError();
		}) as RequestHandler);
		const res = await handler({} as Parameters<RequestHandler>[0]);
		const { status, body } = await read(res as Response);
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});

	it('re-throws a control-flow redirect (never swallowed)', async () => {
		const handler = withReadErrorHandling((() => {
			redirect(303, '/login');
		}) as RequestHandler);
		await expect(handler({} as Parameters<RequestHandler>[0])).rejects.toMatchObject({
			status: 303
		});
	});
});
