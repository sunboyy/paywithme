// THE MAP'S CENTRAL INVARIANT, proved over the WHOLE tree (issue #53; PLAN §7.7,
// §8; ADR-0012):
//
//   "§8 balance math, `/settle`, `/api/v1` and the MCP transaction tools do not
//    read `captures`. Nothing that computes a balance can see a Capture."
//
// Each earlier task proved its own module honest. This one proves the claim about
// the FINISHED surface, and the behavioural half — a real group, real Captures,
// byte-identical balances — is `tests/integration/capture-ledger-blindness.test.ts`
// (a real Postgres, so NOT in the fast gate). This file is the half that runs on
// every task.
//
// ── Why an EXHAUSTIVE sweep, and not a spot check ────────────────────────────
// "No ledger module reads captures" is a claim about every file in the repo, so it
// is answered by enumerating every file in the repo. Both sweeps below assert SET
// EQUALITY against an allowlist: a new importer fails, and so does a disappearing
// one, which means the allowlist cannot rot into a list of names nobody checks. A
// grep of a handful of hand-picked ledger files would prove far less and would go
// stale the moment a route was renamed.
//
// ── Why importers and not an import CLOSURE ──────────────────────────────────
// A transitive walk was the first thing tried, and it is worthless here: Drizzle's
// client (`db/index.ts`) imports the schema BARREL, which re-exports every table
// including `captures`. So `captures-schema.ts` is transitively reachable from
// anything that talks to the database at all — every ledger module included — and
// a closure test would either fail on that meaningless edge or need a carve-out
// wide enough to hide a real one. What actually matters is narrower and checkable
// exactly: to QUERY the table you must hold the `captures` table object, and to
// hold it you must import it by name. So: who imports it, and who imports the one
// service that does?
//
// ── Type-only imports don't count, and can't hide anything ───────────────────
// `mcp/view/capture.ts` does `import type { Capture }`. TypeScript erases that:
// no module is loaded and no query can run, only a shape crosses. It is listed in
// the allowlist anyway (with its kind asserted), so "type-only" stays a fact the
// suite checks rather than a loophole it grants.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiYaml } from '$lib/docs/openapi';

/** Repo root, so every path below reads as it does in a `git` listing. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * PRODUCTION modules allowed to import the `captures` TABLE — i.e. the only two
 * places in the app that can build a query against it.
 *
 * `db/schema.ts` is the Drizzle barrel: it re-exports every table, which is what
 * makes `captures` a table at all. `captures.ts` is the service. Nothing else, and
 * in particular no §8 / `/settle` / `/api/v1` / MCP-ledger module, can name the
 * table — which is what "cannot see a Capture" means in the only place it can be
 * enforced.
 */
const TABLE_IMPORTERS = ['src/lib/server/captures.ts', 'src/lib/server/db/schema.ts'];

/**
 * PRODUCTION modules allowed to import the capture SERVICE, each with why.
 *
 * Read this list as the answer to "who can see a Capture?" — it is the whole
 * answer, because the sweep is exhaustive. Every entry is either a Capture surface
 * (§7.7's tray, count, quick-capture screen, resolve prefill, MCP tools) or the one
 * shared module that names an error class, below. NONE of them computes a balance:
 *
 *   - `/groups` and `/groups/[id]` are on the list because §7.7 REQUIRES the
 *     unrecorded count there. Those pages also render a balance — from a separate
 *     `getGroupBalances` read that has no capture input. Two numbers on one screen
 *     is not one number computed from the other.
 *   - `/groups/[id]/transactions` is on the list because §7.7 puts the "Not
 *     recorded yet" tray ABOVE the transaction list. The tray is rendered beside
 *     the list, never merged into it.
 *   - `/groups/[id]/transactions/new` is the resolve prefill (§7.7 "Resolving"):
 *     it seeds a form from a note. The transaction it writes is validated in full
 *     by §7.4 like any other, which is why resolving is a conversion and not a
 *     shortcut into the ledger.
 */
const SERVICE_IMPORTERS = [
	// The MCP error mapper — the ONE exception, asserted in its own test below.
	'src/lib/server/mcp/errors.ts',
	// The two Connector tools (ADR-0012: the Connector is the fastest capture path).
	'src/lib/server/mcp/tools/create-capture.ts',
	'src/lib/server/mcp/tools/list-captures.ts',
	// A pure row→view mapper; TYPE-ONLY (asserted below), so not a runtime edge.
	'src/lib/server/mcp/view/capture.ts',
	// The unrecorded count (§7.7 "Recall (no push)").
	'src/routes/groups/+page.server.ts',
	'src/routes/groups/[id]/+page.server.ts',
	// The quick-capture screen.
	'src/routes/groups/[id]/captures/new/+page.server.ts',
	// The "Not recorded yet" tray + its discard action.
	'src/routes/groups/[id]/transactions/+page.server.ts',
	// The "Record it" prefill and the resolve that stamps the Capture.
	'src/routes/groups/[id]/transactions/new/+page.server.ts'
];

/** One import/export statement pulled out of a source file. */
interface ImportEdge {
	/** The module specifier, exactly as written. */
	specifier: string;
	/** `import type …` / `export type …` — erased at build, no runtime edge. */
	typeOnly: boolean;
	/** The named bindings, e.g. `['createCapture', 'discardCapture']`. */
	bindings: string[];
}

/** Every `.ts` / `.svelte` file under `src/`, repo-relative, sorted. */
function sourceFiles(dir = 'src'): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (path.endsWith('.ts') || path.endsWith('.svelte')) out.push(path);
	}
	return out.sort();
}

/**
 * The import/export edges declared by one file.
 *
 * Deliberately a regex and not the TypeScript compiler: the question is "does this
 * file name that module", which is answered by the specifier string, and a
 * dependency-free check is one that still runs in five years. Multi-line clauses
 * are handled — `[^'"]*?` spans newlines and stops at the first quote, so a
 * `import {\n  a,\n  b\n} from '…'` is one edge with both bindings.
 */
function importEdges(file: string): ImportEdge[] {
	const source = readFileSync(join(ROOT, file), 'utf8');
	const clause = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^'"]*?)\bfrom\s*['"]([^'"]+)['"]/g;

	return [...source.matchAll(clause)].map((match) => ({
		specifier: match[3],
		typeOnly: match[1] !== undefined,
		bindings: [...match[2].matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
			.map((m) => m[1])
			.filter((name) => name !== 'type' && name !== 'as' && name !== 'default')
	}));
}

/** Does `specifier` name the given capture module, however it is written? */
function names(specifier: string, module: 'service' | 'table'): boolean {
	const tail = specifier.replace(/^(\$lib\/server\/|(\.\.?\/)+)/, '');
	return module === 'service'
		? /^captures$/.test(tail) || specifier === '$lib/server/captures'
		: /captures-schema$/.test(tail);
}

/** Every production (non-test) file whose imports name a capture module. */
function importersOf(module: 'service' | 'table'): string[] {
	return sourceFiles()
		.filter((file) => !/\.(test|spec)\.ts$/.test(file) && !file.endsWith('.svelte.test.ts'))
		.filter((file) => importEdges(file).some((edge) => names(edge.specifier, module)))
		.sort();
}

describe('the sweep has teeth (guards against a vacuous pass)', () => {
	// Every assertion below is of the form "this set is exactly that set". If the
	// scanner silently found nothing, they would all still need the allowlist to be
	// empty — but a corrupted specifier match could make BOTH sides shrink together
	// in a future edit, so pin the mechanism itself first.
	it('scans the whole source tree', () => {
		const files = sourceFiles();
		expect(files.length).toBeGreaterThan(200);
		expect(files).toContain('src/lib/server/balances.ts');
		expect(files).toContain('src/routes/groups/[id]/settle/+page.server.ts');
	});

	it('reads multi-line import clauses, bindings and all', () => {
		const edges = importEdges('src/lib/server/captures.ts');
		const service = edges.find((edge) => edge.specifier === './db/captures-schema');
		expect(service?.bindings).toEqual(['captures']);
		// The multi-line `import { and, count, desc, … } from 'drizzle-orm'`.
		const drizzle = edges.find((edge) => edge.specifier === 'drizzle-orm');
		expect(drizzle?.bindings).toContain('isNull');
	});
});

describe('only the capture service can query `captures` (PLAN §7.7, ADR-0012)', () => {
	// ACCEPTANCE: nothing that computes a balance can see a Capture. A query needs
	// the table object; this is every production file that can name one.
	it('the `captures` table is imported by exactly the service and the schema barrel', () => {
		expect(importersOf('table')).toEqual([...TABLE_IMPORTERS].sort());
	});

	// The same claim from the other end: the dependency between the two halves runs
	// ONE way. `captures.ts` imports `transactions.ts` (it verifies the transaction a
	// resolve points at, and creates the one a resolve records); the ledger imports
	// nothing from the Capture side, which is why `createTransaction` takes an
	// `alsoWrite` hook instead of a `captureId`.
	it('the ledger service imports nothing from the Capture side', () => {
		const edges = importEdges('src/lib/server/transactions.ts');
		expect(edges.filter((edge) => names(edge.specifier, 'service'))).toEqual([]);
		expect(edges.filter((edge) => names(edge.specifier, 'table'))).toEqual([]);
	});

	// §8's two halves — the pure math and the read model that feeds it — plus the
	// `/settle` screen built on them. Stated explicitly because this is the exact
	// sentence §7.7 writes, and a reader should find it asserted under that name
	// rather than have to derive it from the sweep above.
	it.each([
		'src/lib/transactions/balances.ts',
		'src/lib/server/balances.ts',
		'src/routes/groups/[id]/settle/+page.server.ts'
	])('§8 surface `%s` names no capture module', (file) => {
		for (const edge of importEdges(file)) {
			expect(names(edge.specifier, 'service'), edge.specifier).toBe(false);
			expect(names(edge.specifier, 'table'), edge.specifier).toBe(false);
		}
	});
});

describe('who can see a Capture at all — the exhaustive allowlist', () => {
	// ACCEPTANCE: `captures` is absent from the `/api/v1` transaction surfaces and
	// from MCP `list_transactions` / `get_transaction`. Asserted as set equality over
	// the whole tree, so those surfaces are covered by NOT being on the list — along
	// with every other module that computes, serves or renders a balance.
	it('exactly the Capture surfaces import the capture service', () => {
		expect(importersOf('service')).toEqual([...SERVICE_IMPORTERS].sort());
	});

	it('no `/api/v1` route and no MCP ledger tool is on that list', () => {
		// The named halves of the acceptance criterion, spelled out so a failure says
		// which surface grew the dependency rather than just "the set changed".
		const importers = importersOf('service');
		expect(importers.filter((file) => file.startsWith('src/routes/api/v1/'))).toEqual([]);
		for (const tool of [
			'list-transactions',
			'get-transaction',
			'get-balances',
			'create-transaction',
			'update-transaction',
			'delete-transaction',
			'restore-transaction',
			'settle-up'
		]) {
			expect(importers, tool).not.toContain(`src/lib/server/mcp/tools/${tool}.ts`);
		}
	});

	// THE ONE EXCEPTION, pinned to exactly what it is. `mcp/errors.ts` is imported by
	// every MCP tool (it owns `toolSuccess` / `toolError`), so it is the single module
	// through which a ledger tool has any link to the Capture side at all. It takes
	// ONE binding: the validation ERROR CLASS, for an `instanceof` that maps a
	// rejected note to `validation_error` instead of the opaque `internal_error`
	// ADR-0009 forbids for a fixable failure. It reads nothing and calls nothing.
	//
	// If this ever imports a second binding, a ledger tool is one call away from a
	// capture read — which is precisely the drift this test exists to catch.
	it('the MCP error mapper takes the validation error class and nothing else', () => {
		const edges = importEdges('src/lib/server/mcp/errors.ts').filter((edge) =>
			names(edge.specifier, 'service')
		);
		expect(edges).toHaveLength(1);
		expect(edges[0].bindings).toEqual(['CaptureValidationError']);
	});

	// The MCP view mapper is pure (a stored row → a wrapped view) and takes only the
	// `Capture` TYPE, which is erased at build. Asserting the kind keeps "type-only"
	// a checked fact rather than a comment.
	it("the MCP capture view's import of the service is type-only", () => {
		const edges = importEdges('src/lib/server/mcp/view/capture.ts').filter((edge) =>
			names(edge.specifier, 'service')
		);
		expect(edges).toHaveLength(1);
		expect(edges[0].typeOnly).toBe(true);
		expect(edges[0].bindings).toEqual(['Capture']);
	});
});

describe('`captures` is absent from the published `/api/v1` contract (PLAN §16.4, §16.9)', () => {
	// The spec is the contract agents are handed (§16.9), and a Capture has no REST
	// surface at all — no path, no schema, no field on a transaction DTO. A
	// whole-document scan rather than a path-level one precisely because a Capture
	// could only ever leak in as an extra FIELD on an existing schema.
	it('the OpenAPI document mentions no capture anywhere', () => {
		expect(JSON.stringify(loadOpenApiYaml()).toLowerCase()).not.toContain('capture');
	});
});
