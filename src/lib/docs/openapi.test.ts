// Spec-integrity tests for the published OpenAPI document (PLAN §16.9).
//
// Three jobs, all of them anti-rot:
//   1. `openapi.json` is byte-for-byte what `openapi.yaml` generates — the JSON is
//      GENERATED (`pnpm openapi:json`), so a hand-edit or a forgotten regen after a
//      YAML change FAILS THE FAST GATE instead of shipping two divergent specs.
//   2. The spec covers EVERY `/api/v1` operation that actually exists — the route
//      table is derived from the FILESYSTEM (`src/routes/api/v1/**/+server.ts`) and
//      the exported HTTP verbs, so adding an endpoint without documenting it (or
//      documenting one that doesn't exist) is a test failure, not a silent lie.
//   3. The cross-cutting contract is present: relative `servers`, bearer auth, and
//      the reusable error / money components §16.9 requires.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadOpenApiJson, loadOpenApiYaml } from './openapi';

const spec = loadOpenApiYaml();

const ROUTES_DIR = fileURLToPath(new URL('../../routes/api/v1', import.meta.url));

/** Every HTTP method OpenAPI can describe (lowercase, as the spec keys them). */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Walk `src/routes/api/v1/**` and derive the REAL operation table from the endpoint
 * files: one entry per exported HTTP verb, with the SvelteKit path params
 * (`[gid]` → `{gid}`) rewritten to OpenAPI's syntax. The `[...unknown]` catch-all is
 * skipped — it is the 404 fallback (a `fallback` export, not an operation), and
 * documenting it would be nonsense.
 */
function discoverOperations(): string[] {
	const found: string[] = [];

	function walk(dir: string, apiPath: string): void {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				// `[...unknown]` = the catch-all 404 fallback, not a real endpoint.
				if (entry.startsWith('[...')) continue;
				// `[gid]` → `{gid}`.
				const segment = entry.startsWith('[') ? `{${entry.slice(1, -1)}}` : entry;
				walk(full, `${apiPath}/${segment}`);
				continue;
			}
			if (entry !== '+server.ts') continue;

			const source = readFileSync(full, 'utf8');
			for (const method of HTTP_METHODS) {
				// The routes export `export const GET = …` / `export const POST = …`.
				if (new RegExp(`export const ${method.toUpperCase()}\\b`).test(source)) {
					found.push(`${method.toUpperCase()} ${apiPath === '' ? '/' : apiPath}`);
				}
			}
		}
	}

	walk(ROUTES_DIR, '');
	return found.sort();
}

/** The operations the SPEC documents, in the same `METHOD /path` form. */
function specOperations(): string[] {
	const paths = spec.paths as Record<string, Record<string, unknown>>;
	const found: string[] = [];
	for (const [path, item] of Object.entries(paths)) {
		for (const method of HTTP_METHODS) {
			if (item[method]) found.push(`${method.toUpperCase()} ${path}`);
		}
	}
	return found.sort();
}

describe('openapi.json is generated from openapi.yaml', () => {
	it('is in sync with the YAML source of truth (run `pnpm openapi:json`)', () => {
		// Deep-equal on the PARSED documents: the JSON is a pure re-serialization, so
		// any divergence means someone edited the JSON by hand or forgot to regenerate.
		expect(loadOpenApiJson()).toEqual(loadOpenApiYaml());
	});
});

describe('spec-wide conventions (PLAN §16.3, §16.9)', () => {
	it('is OpenAPI 3.1', () => {
		expect(spec.openapi).toBe('3.1.0');
	});

	it('declares a single RELATIVE `servers` base path of `/api/v1` (host-agnostic)', () => {
		expect(spec.servers).toEqual([{ url: '/api/v1', description: expect.any(String) }]);
	});

	it('requires bearer auth globally', () => {
		expect(spec.security).toEqual([{ bearerAuth: [] }]);
		const schemes = (spec.components as Record<string, Record<string, unknown>>).securitySchemes;
		expect(schemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
	});
});

describe('operation coverage (every real endpoint is documented)', () => {
	const real = discoverOperations();
	const documented = specOperations();

	it('discovers the real endpoints from the filesystem (sanity check on the walker)', () => {
		// A guard on the guard: if the walker ever silently found nothing, the coverage
		// assertion below would pass vacuously.
		expect(real).toContain('GET /groups');
		expect(real).toContain('POST /groups/{gid}/settle-up');
		expect(real.length).toBeGreaterThanOrEqual(12);
	});

	it('documents exactly the operations that exist — no gaps, no ghosts', () => {
		expect(documented).toEqual(real);
	});
});

describe('reusable components (PLAN §16.9)', () => {
	const schemas = (spec.components as Record<string, Record<string, unknown>>).schemas;
	const responses = (spec.components as Record<string, Record<string, unknown>>).responses;

	it('defines the money object as `{ amount, currency }` with an INTEGER amount', () => {
		const money = schemas.Money as Record<string, Record<string, Record<string, unknown>>>;
		expect(money.required).toEqual(['amount', 'currency']);
		expect(money.properties.amount.type).toBe('integer');
		// No per-value `exponent`, no pre-formatted `display` (§16.4) — the money shape
		// is exactly two fields, and `additionalProperties: false` keeps it that way.
		expect(Object.keys(money.properties)).toEqual(['amount', 'currency']);
	});

	it('defines the error envelope with every §16.5 code', () => {
		const error = schemas.Error as Record<string, Record<string, Record<string, unknown>>>;
		const inner = error.properties.error as unknown as Record<string, Record<string, unknown>>;
		const code = (inner.properties as Record<string, Record<string, unknown>>).code;
		expect(code.enum).toEqual([
			'bad_request',
			'unauthorized',
			'forbidden_scope',
			'not_found',
			'conflict',
			'validation_error',
			'rate_limited',
			'internal_error'
		]);
	});

	it('has a reusable response per error status, all pointing at the one envelope', () => {
		for (const name of [
			'BadRequest',
			'Unauthorized',
			'ForbiddenScope',
			'NotFound',
			'Conflict',
			'ValidationError',
			'RateLimited',
			'InternalError'
		]) {
			const response = responses[name] as Record<string, Record<string, unknown>>;
			expect(response, `missing response component: ${name}`).toBeDefined();
			const content = response.content as Record<string, Record<string, unknown>>;
			expect(content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Error' });
		}
	});

	it('advertises `Retry-After` on the 429 response (§16.7)', () => {
		const limited = responses.RateLimited as Record<string, Record<string, unknown>>;
		expect(limited.headers).toHaveProperty('Retry-After');
	});
});

describe('per-operation contract details', () => {
	const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;

	it('offers `Idempotency-Key` on BOTH creates and nowhere else (§16.6)', () => {
		const withIdempotency: string[] = [];
		for (const [path, item] of Object.entries(paths)) {
			for (const method of HTTP_METHODS) {
				const op = item[method] as Record<string, unknown> | undefined;
				if (!op) continue;
				const params = (op.parameters ?? []) as { $ref?: string }[];
				if (params.some((p) => p.$ref === '#/components/parameters/IdempotencyKey')) {
					withIdempotency.push(`${method.toUpperCase()} ${path}`);
				}
			}
		}
		expect(withIdempotency.sort()).toEqual([
			'POST /groups/{gid}/settle-up',
			'POST /groups/{gid}/transactions'
		]);
	});

	it('documents 403 `forbidden_scope` on every write operation and on no read (§16.2)', () => {
		const writes = [
			['/groups/{gid}/transactions', 'post'],
			['/groups/{gid}/transactions/{txid}', 'put'],
			['/groups/{gid}/transactions/{txid}', 'delete'],
			['/groups/{gid}/transactions/{txid}/restore', 'post'],
			['/groups/{gid}/settle-up', 'post']
		] as const;

		for (const [path, method] of writes) {
			const op = paths[path][method] as Record<string, Record<string, unknown>>;
			expect(op.responses['403'], `${method} ${path} must document 403`).toEqual({
				$ref: '#/components/responses/ForbiddenScope'
			});
		}

		// A read key may call every GET — so a GET must never advertise 403.
		for (const [path, item] of Object.entries(paths)) {
			const get = item.get as Record<string, Record<string, unknown>> | undefined;
			if (!get) continue;
			expect(get.responses['403'], `GET ${path} must NOT document 403`).toBeUndefined();
		}
	});

	it('creates answer 201 and the other writes 200 (§16.4 response table)', () => {
		expect(paths['/groups/{gid}/transactions'].post.responses).toHaveProperty('201');
		expect(paths['/groups/{gid}/settle-up'].post.responses).toHaveProperty('201');
		expect(paths['/groups/{gid}/transactions/{txid}'].put.responses).toHaveProperty('200');
		expect(paths['/groups/{gid}/transactions/{txid}'].delete.responses).toHaveProperty('200');
		expect(paths['/groups/{gid}/transactions/{txid}/restore'].post.responses).toHaveProperty('200');
	});

	it('caps the transactions-list `limit` at 100 with a default of 50 (§16.4)', () => {
		const params = (spec.components as Record<string, Record<string, Record<string, unknown>>>)
			.parameters;
		expect(params.Limit.schema).toMatchObject({ maximum: 100, default: 50, minimum: 1 });
	});
});
