import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// Mock the auth module so `auth.api.getSession` is a spy: no DB / network.
// `vi.hoisted` lets the spy exist before the hoisted `vi.mock` factory runs.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { getSession } }
}));

// Imported after the mock is registered.
import { handle } from './hooks.server';

/** Minimal fake RequestEvent: only the bits the hook touches. */
function makeEvent(): RequestEvent {
	return {
		request: new Request('http://localhost/'),
		locals: {} as App.Locals
	} as RequestEvent;
}

describe('hooks.server handle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('attaches user/session for an authenticated request', async () => {
		const user = { id: 'user-1', email: 'a@example.com' };
		const session = { id: 'session-1', userId: 'user-1' };
		getSession.mockResolvedValue({ user, session });

		const event = makeEvent();
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await handle({ event, resolve });

		// getSession was called with the request headers.
		expect(getSession).toHaveBeenCalledTimes(1);
		expect(getSession).toHaveBeenCalledWith({ headers: event.request.headers });

		// Locals are populated from the resolved session.
		expect(event.locals.user).toBe(user);
		expect(event.locals.session).toBe(session);

		// resolve was called once with the event, and its result is returned.
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('sets locals to null for an anonymous request', async () => {
		getSession.mockResolvedValue(null);

		const event = makeEvent();
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await handle({ event, resolve });

		expect(event.locals.user).toBeNull();
		expect(event.locals.session).toBeNull();
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);
	});

	it('does not throw and treats the request as anonymous when getSession rejects', async () => {
		getSession.mockRejectedValue(new Error('transient db error'));
		// Silence the expected error log for clean test output.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const event = makeEvent();
		const sentinel = new Response('ok');
		const resolve = vi.fn().mockResolvedValue(sentinel);

		const response = await handle({ event, resolve });

		expect(event.locals.user).toBeNull();
		expect(event.locals.session).toBeNull();
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledWith(event);
		expect(response).toBe(sentinel);

		errorSpy.mockRestore();
	});
});
