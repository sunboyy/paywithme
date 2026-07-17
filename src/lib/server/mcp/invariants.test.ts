// SURFACE-WIDE structural invariants of the whole MCP tool set (issue #36).
//
// The per-tool suites each prove one tool honest. These prove things that are only
// true of the FINISHED surface — claims about the SET of tools no single per-tool
// ticket could make because it only ever saw a partial registry. They are the
// registry-level half of #36 (the behavioural half — envelope wrapping, 404
// conflation, audit provenance — lives in `tests/integration/mcp-boundary.test.ts`,
// which needs a real Postgres and is NOT in the fast gate).
//
// EVERYTHING here ENUMERATES the live `MCP_TOOLS` / `filterToolsByScope` rather than
// a hand-maintained name list. That is the whole point: adding a tool that violates
// an ADR-0002/0003 invariant must fail the FAST GATE immediately, so an unannotated
// or mis-scoped tool cannot slip in on a future task. Where a specific NAME is
// asserted literally (`delete_transaction`), it is because the invariant is about
// that exact tool being the sole exception — deriving it would let the exception
// move silently.

import { describe, it, expect } from 'vitest';
import { MCP_TOOLS, filterToolsByScope } from './tools';

/** Every registered tool's wire name — the surface the tests below iterate. */
const ALL_NAMES = MCP_TOOLS.map((t) => t.definition.name);
/** The scope each tool DECLARES — what `tools/list` filters on and the dispatcher enforces. */
const readScoped = MCP_TOOLS.filter((t) => t.scope === 'read').map((t) => t.definition.name);
const writeScoped = MCP_TOOLS.filter((t) => t.scope === 'write').map((t) => t.definition.name);

describe('every tool is fully annotated (ADR-0002, issue #36)', () => {
	// The enumeration must not be vacuous: if the registry were ever empty (a bad
	// merge, a refactor that dropped the exports) every `it.each` below would pass by
	// running zero cases. Pin the surface is non-empty so the sweep has teeth.
	it('the registry is non-empty, so the per-tool sweeps actually run', () => {
		expect(ALL_NAMES.length).toBeGreaterThan(0);
		// No duplicate names — `findTool` returns the FIRST match, so a dup would let one
		// tool silently shadow another and every enumeration below would under-count it.
		expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
	});

	// ACCEPTANCE: "Every tool declares BOTH readOnlyHint and destructiveHint" — the two
	// flags ADR-0002/0003 rest on (the approval UI reads them). Enumerated, so a new
	// tool that forgets one — or ships a truthy non-boolean that looks set but isn't —
	// fails here rather than reaching Claude's UI unannotated.
	it.each(ALL_NAMES)('`%s` declares readOnlyHint AND destructiveHint as booleans', (name) => {
		const tool = MCP_TOOLS.find((t) => t.definition.name === name);
		const annotations = tool?.definition.annotations;
		expect(typeof annotations?.readOnlyHint, `${name}.readOnlyHint`).toBe('boolean');
		expect(typeof annotations?.destructiveHint, `${name}.destructiveHint`).toBe('boolean');
	});

	// The scope a tool declares and the read-only flag it advertises must ALWAYS agree,
	// in BOTH directions. This is the derived guard against a mis-scoped NEW tool: a
	// write tool honestly annotated `readOnlyHint: false` but mistakenly given
	// `scope: 'read'` (which would leak it into a read key's `tools/list`) fails here,
	// and so does a read tool needlessly hidden behind `scope: 'write'`.
	it('scope and readOnlyHint agree for every tool — read ⟺ read-only', () => {
		for (const tool of MCP_TOOLS) {
			expect(tool.definition.annotations.readOnlyHint, tool.definition.name).toBe(
				tool.scope === 'read'
			);
		}
	});
});

describe('destructiveHint is exclusive to delete_transaction (ADR-0003, issue #36)', () => {
	// ACCEPTANCE: `delete_transaction` is the ONLY tool with `destructiveHint: true`.
	// The flag only carries information — and Claude's approval UI only gates a delete
	// HARDER than a write — if exactly one tool claims it. A `destructiveHint: true`
	// set defensively on everything that mutates would gate a typo fix like a deletion,
	// and the user would learn to click through both. Derived from the live registry so
	// a second tool quietly claiming the flag fails immediately.
	it('exactly one tool is destructive, and it is `delete_transaction`', () => {
		const destructive = MCP_TOOLS.filter(
			(t) => t.definition.annotations.destructiveHint === true
		).map((t) => t.definition.name);
		expect(destructive).toEqual(['delete_transaction']);
	});
});

describe('the scope-filtered tool matrix (ADR-0002, issue #36)', () => {
	// ACCEPTANCE: a Read key's `tools/list` omits EVERY write tool — the full matrix,
	// not a spot check. The `filterToolsByScope('read')` list must be EXACTLY the
	// read-scoped tools, in registry order, with no write tool anywhere in it.
	it('a read key sees exactly the read-scoped tools — no write tool leaks in', () => {
		const readList = filterToolsByScope('read').map((t) => t.name);
		expect(readList).toEqual(readScoped);
		// Derived from `scope === 'write'`, so a NEWLY-added write tool is automatically
		// required to be absent from the read list — a mis-scoped one would appear here.
		for (const writeName of writeScoped) {
			expect(readList, writeName).not.toContain(writeName);
		}
	});

	it('a write key sees the read surface PLUS every write tool (write ⊇ read, no gaps)', () => {
		const writeList = filterToolsByScope('write').map((t) => t.name);
		// A superset of the read surface …
		for (const readName of readScoped) {
			expect(writeList, readName).toContain(readName);
		}
		// … that additionally contains every write-scoped tool …
		for (const writeName of writeScoped) {
			expect(writeList, writeName).toContain(writeName);
		}
		// … and COMPLETENESS: no registered tool is silently omitted from a write key's
		// view. A new tool that fell out of the filter entirely (neither scope matched)
		// would be caught here even though the two loops above would not notice it.
		expect(writeList).toEqual(ALL_NAMES);
	});

	// The two scopes must PARTITION the surface: every tool is either read- or
	// write-scoped, and the two sets do not overlap. A tool with some other scope value
	// would be missing from both lists above; asserting the partition makes that loud.
	it('read-scoped and write-scoped tools partition the whole registry', () => {
		expect([...readScoped, ...writeScoped].sort()).toEqual([...ALL_NAMES].sort());
		expect(readScoped.some((n) => writeScoped.includes(n))).toBe(false);
	});
});
