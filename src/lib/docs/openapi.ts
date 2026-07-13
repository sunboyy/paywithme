// Loader for the published OpenAPI 3.1 spec (PLAN §16.9).
//
// The spec is a STATIC ASSET (`static/api/v1/openapi.(yaml|json)`), served verbatim
// by SvelteKit at `/api/v1/openapi.yaml` — static assets are resolved BEFORE routes,
// so the `/api/v1/[...unknown]` catch-all never sees those two paths and they are
// readable without a key (deliberately: an agent's operator reads the spec before
// they have one).
//
// NODE-ONLY (it reads from disk). Nothing in the app imports this — it exists so the
// spec-sync and contract tests (§16.10) can load the very bytes we publish and hold
// the code to them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** Absolute path to the hand-written source of truth. */
export const OPENAPI_YAML_FILE = fileURLToPath(
	new URL('../../../static/api/v1/openapi.yaml', import.meta.url)
);

/** Absolute path to the file GENERATED from it (`pnpm openapi:json`). */
export const OPENAPI_JSON_FILE = fileURLToPath(
	new URL('../../../static/api/v1/openapi.json', import.meta.url)
);

/** A parsed OpenAPI document — walked structurally by the tests, so kept loose. */
export type OpenApiDocument = Record<string, unknown>;

/** Parse the hand-written YAML spec. */
export function loadOpenApiYaml(): OpenApiDocument {
	return parse(readFileSync(OPENAPI_YAML_FILE, 'utf8')) as OpenApiDocument;
}

/** Parse the generated JSON spec. */
export function loadOpenApiJson(): OpenApiDocument {
	return JSON.parse(readFileSync(OPENAPI_JSON_FILE, 'utf8')) as OpenApiDocument;
}
