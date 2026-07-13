import { expect, test } from '@playwright/test';

// `/docs/api` + the raw OpenAPI spec, against a REAL built server (PLAN §16.9).
//
// The load-bearing thing only an e2e can prove: `static/api/v1/openapi.(yaml|json)`
// is served VERBATIM at `/api/v1/openapi.*`, i.e. the static asset wins over BOTH the
// `/api/v1/*` auth hook (which 401s every unauthenticated API request) and the
// `/api/v1/[...unknown]` catch-all 404. Static assets are resolved before routes — a
// 401 or a `not_found` envelope here would mean the spec is unreachable for the
// agents it exists for, and we'd have to serve it from a route instead.

test('the raw OpenAPI spec is served without an API key', async ({ request }) => {
	const yaml = await request.get('/api/v1/openapi.yaml');
	expect(yaml.status()).toBe(200);
	expect(await yaml.text()).toContain('openapi: 3.1.0');

	const json = await request.get('/api/v1/openapi.json');
	expect(json.status()).toBe(200);
	const spec = await json.json();
	expect(spec.openapi).toBe('3.1.0');
	// Host-agnostic, relative base path.
	expect(spec.servers).toEqual([{ url: '/api/v1', description: expect.any(String) }]);
});

test('an unknown /api/v1 path still 401s (the spec is a static-asset exception, not a hole)', async ({
	request
}) => {
	const res = await request.get('/api/v1/openapi.txt');
	expect(res.status()).toBe(401);
	expect(await res.json()).toEqual({
		error: { code: 'unauthorized', message: 'Authentication required.' }
	});
});

test('/docs/api renders the quickstart and links to the raw spec', async ({ page }) => {
	await page.goto('/docs/api');

	await expect(page).toHaveTitle(/API docs/);
	await expect(page.getByRole('heading', { level: 1, name: 'API docs' })).toBeVisible();
	// The quickstart's three steps (`Card.Title` renders a div, so match the step headings).
	await expect(page.getByText('Quickstart', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: '2. Read: list your groups' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '3. Write: record a transaction' })).toBeVisible();

	// The quickstart's write step shows the header trio + integer-minor-unit money.
	await expect(page.getByText('Idempotency-Key: ramen-2026-05-04-01')).toBeVisible();
	await expect(page.getByText('"amountTotal": 90000').first()).toBeVisible();

	// It ends in a prominent link to the raw spec (the single source of truth).
	await expect(page.getByRole('link', { name: 'OpenAPI spec (YAML)' })).toHaveAttribute(
		'href',
		'/api/v1/openapi.yaml'
	);
});
