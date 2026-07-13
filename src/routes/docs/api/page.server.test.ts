import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Load tests for `/docs/api` (PLAN §16.9).
//
// The one behaviour worth pinning here: the quickstart's `curl` examples address a
// REAL origin — the deployment's canonical one (`BETTER_AUTH_URL`) or, failing that,
// the host the reader is actually on. A hard-coded example domain is a silent trap:
// it renders fine, and every agent that copies it calls the wrong host.
//
// Env-mocking follows `lib/server/email.test.ts`: `vi.stubEnv` does NOT flow into
// `$env/dynamic/private` under Vitest, so each test mocks that module directly,
// resets the module registry, and dynamically imports the load.

function mockEnv(values: Record<string, string | undefined>): void {
	vi.doMock('$env/dynamic/private', () => ({ env: values }));
}

/** What the load returns, narrowed to the parts these tests read. */
interface DocsData {
	origin: string;
	quickstart: { readCommand: string; writeCommand: string };
}

/**
 * Import the load fresh (so it re-reads the per-test env) and call it with the slice
 * of `RequestEvent` it actually touches. The cast on both sides mirrors the other
 * `page.server.test.ts` files: SvelteKit's generated `load` signature is far wider
 * than what the function reads.
 */
async function loadWith(requestOrigin: string): Promise<DocsData> {
	const { load } = await import('./+page.server');
	const event = { url: new URL(`${requestOrigin}/docs/api`) } as Parameters<typeof load>[0];
	return (await load(event)) as unknown as DocsData;
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
});

describe('/docs/api load', () => {
	it('addresses the canonical origin from env when it is configured', async () => {
		mockEnv({ BETTER_AUTH_URL: 'https://pay.example.org' });

		// The request host is a preview URL — operators do not call that one, so the
		// configured canonical origin must win.
		const data = await loadWith('https://preview-xyz.vercel.app');

		expect(data.origin).toBe('https://pay.example.org');
		expect(data.quickstart.readCommand).toContain('https://pay.example.org/api/v1/groups');
		expect(data.quickstart.writeCommand).toContain(
			'https://pay.example.org/api/v1/groups/grp_tokyo/transactions'
		);
	});

	it('falls back to the origin the docs are being served from', async () => {
		// Zero-config deployment: the reader still gets a `curl` that works on THIS host.
		mockEnv({});

		const data = await loadWith('https://pay.example.org');

		expect(data.origin).toBe('https://pay.example.org');
		expect(data.quickstart.readCommand).toContain('https://pay.example.org/api/v1/groups');
	});

	it('never renders a hard-coded example host', async () => {
		// The regression guard: whatever origin the page resolves, it is the one it was
		// given — no placeholder domain survives anywhere in the copy-pasteable blocks.
		mockEnv({});

		const data = await loadWith('https://pay.example.org');

		for (const command of [data.quickstart.readCommand, data.quickstart.writeCommand]) {
			expect(command.match(/https?:\/\/[^\s/]+/g)).toEqual(['https://pay.example.org']);
		}
	});
});
