// `/docs/api` — the public API prose docs (PLAN §16.9).
//
// SERVER-RENDERED (a `+page.server.ts` + `+page.svelte` pair, no JS API-explorer
// dependency in v1): the page is a quickstart + the §16 conventions, ending in a
// prominent link to the raw spec. Per-endpoint request/response shapes live ONLY in
// the OpenAPI spec (`static/api/v1/openapi.yaml`, served verbatim) so the prose can
// never drift from the contract.
//
// The load is a pure projection of the `$lib/docs/api-quickstart` module — the same
// module the contract test shape-checks against the spec's component schemas — so
// what a reader copies off this page is exactly what the API accepts. No DB, no
// auth: the docs are public (an agent's operator reads them BEFORE they have a key).

import { env } from '$env/dynamic/private';
import {
	API_BASE_PATH,
	OPENAPI_JSON_PATH,
	OPENAPI_YAML_PATH,
	KEY_ENV_VAR,
	quickstartReadCommand,
	quickstartWriteCommand,
	QUICKSTART_GROUPS_RESPONSE,
	QUICKSTART_CREATE_RESPONSE,
	QUICKSTART_ERROR_RESPONSE,
	formatJson,
	resolveDocsOrigin
} from '$lib/docs/api-quickstart';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	// The `curl` examples address the origin this page is ACTUALLY served from —
	// never a hard-coded example host, which a reader would have to notice and edit.
	// `BETTER_AUTH_URL` (the app's canonical origin) wins when set, because behind a
	// proxy or on a preview URL the request host isn't the origin operators call.
	// `$env/dynamic/private` so a redeploy picks it up without a rebuild.
	const origin = resolveDocsOrigin({
		requestOrigin: url.origin,
		configuredOrigin: env.BETTER_AUTH_URL
	});

	return {
		basePath: API_BASE_PATH,
		specYamlPath: OPENAPI_YAML_PATH,
		specJsonPath: OPENAPI_JSON_PATH,
		keyEnvVar: KEY_ENV_VAR,
		origin,
		quickstart: {
			readCommand: quickstartReadCommand(origin),
			writeCommand: quickstartWriteCommand(origin),
			// Pre-formatted here (not in the template) so the page renders the SAME bytes
			// the contract test validates.
			groupsResponse: formatJson(QUICKSTART_GROUPS_RESPONSE),
			createResponse: formatJson(QUICKSTART_CREATE_RESPONSE),
			errorResponse: formatJson(QUICKSTART_ERROR_RESPONSE)
		}
	};
};
