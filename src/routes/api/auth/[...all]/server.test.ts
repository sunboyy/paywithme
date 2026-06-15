// Unit test for the better-auth catch-all mount (PLAN §5.1).
//
// We mock `$lib/server/auth` so the test is hermetic (no DB / env / Mailgun)
// and assert the real contract: the exported GET/POST handlers delegate to
// `auth.handler`, passing through the EXACT incoming `Request` and returning
// the handler's response unchanged. The assertions would fail if someone
// stopped delegating, passed the wrong argument, or dropped the return value.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Sentinel response the mocked handler returns, so we can assert pass-through.
// `vi.hoisted` lets these live alongside the hoisted `vi.mock` factory below.
const { sentinel, handlerSpy } = vi.hoisted(() => {
	const sentinel = new Response('ok', { status: 200 });
	return { sentinel, handlerSpy: vi.fn(async () => sentinel) };
});

vi.mock('$lib/server/auth', () => ({
	auth: { handler: handlerSpy }
}));

// Imported after the mock is registered (vi.mock is hoisted, but importing
// here keeps the dependency order explicit).
import { GET, POST } from './+server';

// Minimal `RequestEvent`-shaped object: the route only reads `request`.
function makeEvent(request: Request) {
	return { request } as unknown as Parameters<typeof GET>[0];
}

describe('/api/auth/[...all] +server', () => {
	beforeEach(() => {
		handlerSpy.mockClear();
	});

	it('GET delegates to auth.handler with the incoming request and returns its response', async () => {
		const request = new Request('http://localhost/api/auth/session');
		const event = makeEvent(request);

		const response = await GET(event);

		expect(handlerSpy).toHaveBeenCalledTimes(1);
		expect(handlerSpy).toHaveBeenCalledWith(request);
		expect(response).toBe(sentinel);
	});

	it('POST delegates to auth.handler with the incoming request and returns its response', async () => {
		const request = new Request('http://localhost/api/auth/sign-in/magic-link', {
			method: 'POST'
		});
		const event = makeEvent(request);

		const response = await POST(event);

		expect(handlerSpy).toHaveBeenCalledTimes(1);
		expect(handlerSpy).toHaveBeenCalledWith(request);
		expect(response).toBe(sentinel);
	});

	it('GET and POST resolve to the same delegating handler', () => {
		expect(GET).toBe(POST);
	});
});
