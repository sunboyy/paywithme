#!/usr/bin/env node
// Generate `static/api/v1/openapi.json` from `static/api/v1/openapi.yaml` (PLAN §16.9).
//
// The YAML is the hand-written SINGLE SOURCE OF TRUTH; the JSON is a pure
// re-serialization of it, published alongside so an agent can ingest either. It is
// GENERATED — never hand-edit `openapi.json`. Run `pnpm openapi:json` after touching
// the YAML; `src/lib/docs/openapi.test.ts` fails the fast gate if the two ever drift,
// so the drift can't be committed by accident.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const yamlPath = fileURLToPath(new URL('../static/api/v1/openapi.yaml', import.meta.url));
const jsonPath = fileURLToPath(new URL('../static/api/v1/openapi.json', import.meta.url));

const spec = parse(readFileSync(yamlPath, 'utf8'));

// Tab-indented + trailing newline so the emitted file already satisfies Prettier
// (`useTabs`), and `pnpm format:check` stays green without an ignore entry.
writeFileSync(jsonPath, `${JSON.stringify(spec, null, '\t')}\n`, 'utf8');

console.log(`[openapi] wrote ${jsonPath}`);
