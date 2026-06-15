import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit tests for the server email helper (PLAN §5.2, task #24).
//
// Env-mocking approach: the helper reads Mailgun config from
// `$env/dynamic/private`. Per task 2.1, `vi.stubEnv` does NOT flow into
// `$env/dynamic/private` under Vitest, so each test instead mocks that module
// directly with `vi.doMock('$env/dynamic/private', () => ({ env: {...} }))`,
// calls `vi.resetModules()`, and dynamically `import()`s `./email` so the module
// re-reads the per-test env. `fetch` is stubbed with `vi.stubGlobal` so no test
// touches the real network.

const REAL_KEY = 'key-super-secret-abc123';

function mockEnv(values: Record<string, string>): void {
	vi.doMock('$env/dynamic/private', () => ({ env: values }));
}

async function importEmail() {
	return import('./email');
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.resetModules();
});

describe('sendEmail — dev fallback (Mailgun unconfigured)', () => {
	it('does not call fetch, logs a dev-fallback line, and resolves when env is empty', async () => {
		mockEnv({ MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', EMAIL_FROM: '' });
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		const { sendEmail } = await importEmail();
		await expect(
			sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'body text' })
		).resolves.toBeUndefined();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		const logged = log.mock.calls[0].join(' ');
		expect(logged).toContain('[email] (dev fallback)');
		expect(logged).toContain('a@b.com');
		expect(logged).toContain('Hi');
		expect(logged).toContain('body text');
	});

	it('falls back to dev mode when only some Mailgun vars are set', async () => {
		// Domain + from present but no API key → still unconfigured, must not send.
		mockEnv({
			MAILGUN_API_KEY: '',
			MAILGUN_DOMAIN: 'mg.example.com',
			EMAIL_FROM: 'x@mg.example.com'
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		vi.spyOn(console, 'log').mockImplementation(() => {});

		const { sendEmail } = await importEmail();
		await sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'x' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('sendEmail — configured (Mailgun HTTP API)', () => {
	const configured = {
		MAILGUN_API_KEY: REAL_KEY,
		MAILGUN_DOMAIN: 'mg.example.com',
		MAILGUN_BASE_URL: 'https://api.eu.mailgun.net',
		EMAIL_FROM: 'Pay with me <noreply@mg.example.com>'
	};

	it('POSTs to the messages endpoint with basic auth and a form body', async () => {
		mockEnv(configured);
		const fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		const { sendEmail } = await importEmail();
		await sendEmail({ to: 'a@b.com', subject: 'Sign in', text: 'click here', html: '<b>hi</b>' });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
		expect(init.method).toBe('POST');

		// Authorization: Basic base64('api:<key>')
		const expectedAuth = `Basic ${Buffer.from(`api:${REAL_KEY}`).toString('base64')}`;
		expect(init.headers.Authorization).toBe(expectedAuth);

		// Body carries the required Mailgun fields.
		const body = init.body as URLSearchParams;
		expect(body.get('from')).toBe(configured.EMAIL_FROM);
		expect(body.get('to')).toBe('a@b.com');
		expect(body.get('subject')).toBe('Sign in');
		expect(body.get('text')).toBe('click here');
		expect(body.get('html')).toBe('<b>hi</b>');

		// No-secret-leak: the raw API key is never logged, and never appears in the
		// request URL or body (only inside the opaque base64 auth header).
		expect(log).not.toHaveBeenCalled();
		expect(url).not.toContain(REAL_KEY);
		expect(body.toString()).not.toContain(REAL_KEY);
	});

	it('omits html from the body when not provided', async () => {
		mockEnv(configured);
		const fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);

		const { sendEmail } = await importEmail();
		await sendEmail({ to: 'a@b.com', subject: 'S', text: 'T' });

		const body = fetchSpy.mock.calls[0][1].body as URLSearchParams;
		expect(body.has('html')).toBe(false);
	});

	it('defaults MAILGUN_BASE_URL to the US endpoint when unset', async () => {
		mockEnv({
			MAILGUN_API_KEY: REAL_KEY,
			MAILGUN_DOMAIN: 'mg.example.com',
			EMAIL_FROM: 'x@mg.example.com'
		});
		const fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);

		const { sendEmail } = await importEmail();
		await sendEmail({ to: 'a@b.com', subject: 'S', text: 'T' });

		expect(fetchSpy.mock.calls[0][0]).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
	});
});

describe('sendEmail — error path', () => {
	it('throws on a non-2xx response without leaking the API key', async () => {
		mockEnv({
			MAILGUN_API_KEY: REAL_KEY,
			MAILGUN_DOMAIN: 'mg.example.com',
			EMAIL_FROM: 'x@mg.example.com'
		});
		const fetchSpy = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
		vi.stubGlobal('fetch', fetchSpy);

		const { sendEmail } = await importEmail();
		await expect(sendEmail({ to: 'a@b.com', subject: 'S', text: 'T' })).rejects.toThrow(/401/);

		// The thrown message includes the status/body but never the credential.
		const err = await sendEmail({ to: 'a@b.com', subject: 'S', text: 'T' }).catch((e) => e);
		expect(String(err)).toContain('401');
		expect(String(err)).not.toContain(REAL_KEY);
	});
});

describe('sendMagicLinkEmail', () => {
	it('composes a subject + body containing the url and delegates to the Mailgun POST', async () => {
		mockEnv({
			MAILGUN_API_KEY: REAL_KEY,
			MAILGUN_DOMAIN: 'mg.example.com',
			EMAIL_FROM: 'x@mg.example.com'
		});
		const fetchSpy = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		vi.stubGlobal('fetch', fetchSpy);

		const { sendMagicLinkEmail } = await importEmail();
		const url = 'http://localhost:5173/verify?token=tok123';
		await sendMagicLinkEmail({ to: 'a@b.com', url });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const body = fetchSpy.mock.calls[0][1].body as URLSearchParams;
		expect(body.get('to')).toBe('a@b.com');
		expect(body.get('subject')).toBe('Sign in to Pay with me');
		expect(body.get('text')).toContain(url);
		// Mentions the single-use / short-lived nature (PLAN §5.3).
		expect(body.get('text')).toMatch(/single-use|expires/i);
	});

	it('logs the magic-link url via the dev fallback when Mailgun is unconfigured', async () => {
		mockEnv({ MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', EMAIL_FROM: '' });
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		const { sendMagicLinkEmail } = await importEmail();
		const url = 'http://localhost:5173/verify?token=tok123';
		await sendMagicLinkEmail({ to: 'a@b.com', url });

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(log.mock.calls[0].join(' ')).toContain(url);
	});
});
