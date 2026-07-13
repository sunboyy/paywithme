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
import Ajv2020 from 'ajv/dist/2020.js';

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

/** The outcome of validating one value against a component schema. */
export interface SchemaCheck {
	ok: boolean;
	/** Ajv's field-level errors, one per line — empty when `ok`. */
	errors: string;
}

/**
 * Compile the spec's `#/components/schemas/*` and hand back a checker for them
 * (PLAN §16.10). ONE Ajv configuration, shared by BOTH contract tests — the
 * fixture-level one (`openapi.contract.test.ts`, which validates the DTO mappers +
 * the `/docs/api` quickstart) and the LIVE one
 * (`tests/integration/api-contract.test.ts`, which validates the bodies the real
 * routes return over the wire). A single config means the two can never disagree
 * about what "valid" means.
 *
 * `strict: false` + `validateFormats: false`: an OpenAPI document carries annotation
 * keywords Ajv doesn't know (`example`, `summary`, `discriminator`, `format:
 * date-time`). We validate STRUCTURE — required fields, types, enums, and the
 * `additionalProperties: false` that makes an UNDOCUMENTED field a failure — which is
 * exactly the part of the contract a client depends on. OpenAPI 3.1 schemas ARE JSON
 * Schema 2020-12, so they compile as-is.
 */
export function createComponentSchemaChecker(spec: OpenApiDocument = loadOpenApiYaml()): {
	check: (schemaName: string, value: unknown) => SchemaCheck;
} {
	const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
	ajv.addSchema(spec, 'openapi');

	return {
		check(schemaName, value) {
			const validate = ajv.getSchema(`openapi#/components/schemas/${schemaName}`);
			if (!validate) throw new Error(`No such component schema: ${schemaName}`);
			const ok = validate(value) === true;
			return { ok, errors: ok ? '' : ajv.errorsText(validate.errors, { separator: '\n  ' }) };
		}
	};
}
