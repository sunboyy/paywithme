// Unit test for the `/api/v1/*` catch-all 404 route (PLAN §16.3, §16.5).
//
// Any unknown `/api/v1/*` path, on ANY method, must return the stable 404
// `not_found` envelope. The route exports a single `fallback` handler covering
// every verb, so we assert the same envelope regardless of method.

import { describe, it, expect } from 'vitest';
import { fallback } from './+server';

/** Minimal RequestEvent — the handler ignores the event entirely. */
function makeEvent(method: string) {
	const url = new URL('http://localhost/api/v1/does-not-exist');
	return {
		request: new Request(url, { method }),
		url
	} as unknown as Parameters<typeof fallback>[0];
}

async function read(res: Response) {
	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		body: await res.json()
	};
}

describe('/api/v1/[...unknown] fallback', () => {
	it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])(
		'%s on an unknown path → 404 not_found envelope',
		async (method) => {
			const res = await fallback(makeEvent(method));
			const { status, contentType, body } = await read(res as Response);
			expect(status).toBe(404);
			expect(contentType).toContain('application/json');
			expect(body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
		}
	);

	it('never leaks whether the path exists (conflated with no-access)', async () => {
		const res = (await fallback(makeEvent('GET'))) as Response;
		const body = await res.json();
		// Same generic code/message a no-access resource would return — no signal.
		expect(body.error.code).toBe('not_found');
	});
});
