// Real-DB proof of the Capture map's CENTRAL INVARIANT (issue #53; PLAN §7.7, §8,
// §12.1; ADR-0012):
//
//   "§8 balance math, `/settle`, `/api/v1` and the MCP transaction tools do not
//    read `captures`. Nothing that computes a balance can see a Capture."
//
// The sibling fast-gate suite (`src/lib/server/capture-ledger-blindness.test.ts`)
// proves it STRUCTURALLY — nothing outside the Capture surfaces can even name the
// table. This one proves it BEHAVIOURALLY, against a running Postgres, because a
// structural argument does not rule out a raw SQL string or a join nobody noticed.
//
// ── The shape of the proof: byte-identical, not "looks the same" ─────────────
// The suite snapshots every ledger surface (the §8 math, `/settle`'s "who should
// pay" and its suggested settlements, the `/api/v1` transaction + balance
// endpoints, and MCP `get_balances` / `list_transactions` / `get_transaction`),
// fills the group with open Captures — including ones carrying an `amount_minor`,
// one in a FOREIGN currency, and one large enough to dominate every balance if it
// were ever counted — and asserts the snapshot is the SAME STRING. Not "the totals
// match": the same bytes. A provisional "±$500 pending" annotation anywhere in any
// payload fails, which is exactly what §7.7 forbids ("not even as a provisional
// note on a balance").
//
// Two things keep that from being a test that would pass on an empty group:
//   - The baseline is asserted NON-TRIVIAL first (real debts, a real suggestion).
//   - The Captures are asserted PRESENT on their own surface, and the resolve at
//     the end DOES move the balances — the one and only thing that may.
//
// Cleanup mirrors the `/api/v1` suite: `cleanupApiKeyRows()` then
// `cleanupSuiteRows()` (groups cascade to transactions, captures and members).

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getGroupBalances } from '$lib/server/balances';
import { orderByWhoShouldPay, suggestSettlements } from '$lib/transactions/balances';
import {
	countOpenCapturesByGroup,
	createCapture,
	discardCapture,
	listOpenCaptures,
	recordCaptureAsTransaction
} from '$lib/server/captures';
import { createTransaction } from '$lib/server/transactions';
import { listGroupActivity } from '$lib/server/activity';
import { actionLabel, entityTypeLabel } from '$lib/activity-labels';
import { auditLog } from '$lib/server/db/audit-schema';
import { cleanupSuiteRows, db, describeIntegration } from './helpers';
import { apiCall, cleanupApiKeyRows } from './api-client';
import { createApiScenario, spendingInput, type ApiScenario } from './api-fixtures';
import { mcpToolCall, type JsonRpcWire, type ToolResultWire } from './mcp-client';

/**
 * The note text planted in every Capture below. Long and distinctive so the
 * "no capture text anywhere in a ledger payload" scan cannot match by accident.
 */
const NOTE_MARKER = 'zz-note-marker-53';

describeIntegration('integration: Captures never reach the ledger (issue #53)', () => {
	let s: ApiScenario;
	/** The ids of the transactions seeded into the baseline ledger. */
	let seeded: string[];

	beforeEach(async () => {
		s = await createApiScenario('cap53');
		seeded = [
			// Alice pays $90 split between both → Bob owes Alice $45.
			await createTransaction({
				userId: s.user.id,
				groupId: s.group.id,
				input: spendingInput({ payerId: s.alice, beneficiaryIds: [s.alice, s.bob], amount: 9000 })
			}),
			// Bob pays $30 split between both → the net narrows to $30.
			await createTransaction({
				userId: s.user.id,
				groupId: s.group.id,
				input: spendingInput({
					payerId: s.bob,
					beneficiaryIds: [s.alice, s.bob],
					amount: 3000,
					title: 'Taxi'
				})
			})
		];
	});

	afterEach(async () => {
		await cleanupApiKeyRows();
		await cleanupSuiteRows();
	});

	// ── snapshotting ───────────────────────────────────────────────────────────

	/**
	 * Every §8 output for the group, serialized. `getGroupBalances` is the read model
	 * the `/settle` page uses; `orderByWhoShouldPay` (§8.2) and `suggestSettlements`
	 * (§8.3) are the exact pure functions it pipes it through, so this is that screen's
	 * whole content in one string.
	 */
	async function ledgerMath(): Promise<string> {
		const balances = await getGroupBalances({ userId: s.user.id, groupId: s.group.id });
		return JSON.stringify({
			balances,
			whoShouldPay: orderByWhoShouldPay(balances),
			suggestions: suggestSettlements(balances)
		});
	}

	/** The `/api/v1` transaction + balance surfaces, serialized (PLAN §16.4). */
	async function restSurfaces(): Promise<string> {
		const key = s.readKey.key;
		const base = `/api/v1/groups/${s.group.id}`;
		const [balances, list, detail] = await Promise.all([
			apiCall('GET', `${base}/balances`, { key }),
			apiCall('GET', `${base}/transactions`, { key }),
			apiCall('GET', `${base}/transactions/${seeded[0]}`, { key })
		]);
		return JSON.stringify({
			balances: balances.body,
			list: list.body,
			detail: detail.body
		});
	}

	/** One MCP tool's `structuredContent`, or its text payload if it has none. */
	async function mcpResult(name: string, args: Record<string, unknown>): Promise<unknown> {
		const res = await mcpToolCall(name, args, { key: s.readKey.key });
		const wire = res.body as JsonRpcWire<ToolResultWire>;
		expect(wire.error, `${name} errored`).toBeUndefined();
		expect(wire.result?.isError, `${name} returned a tool error`).not.toBe(true);
		return wire.result?.structuredContent ?? JSON.parse(wire.result?.content?.[0]?.text ?? 'null');
	}

	/** The MCP ledger tools' payloads, serialized (ADR-0012's own list). */
	async function mcpSurfaces(): Promise<string> {
		const groupId = s.group.id;
		return JSON.stringify({
			balances: await mcpResult('get_balances', { groupId }),
			list: await mcpResult('list_transactions', { groupId }),
			detail: await mcpResult('get_transaction', { groupId, transactionId: seeded[0] })
		});
	}

	/** Everything a Capture must not change, in one string. */
	async function ledgerSnapshot(): Promise<string> {
		return JSON.stringify({
			math: await ledgerMath(),
			rest: await restSurfaces(),
			mcp: await mcpSurfaces()
		});
	}

	/**
	 * Fill the group with open Captures — the adversarial set, not a token one:
	 *   - a note-only Capture (no money at all),
	 *   - one in the group's OWN settlement currency, so a naive join would find a
	 *     directly-addable number,
	 *   - one in a FOREIGN currency with no rate anywhere (§7.7 "uninterpreted"),
	 *   - one an order of magnitude larger than every real transaction, so if any
	 *     surface ever counted a Capture the diff would be impossible to miss.
	 */
	async function fillWithCaptures(): Promise<string[]> {
		const inputs = [
			{ note: `${NOTE_MARKER} note only` },
			{ note: `${NOTE_MARKER} settlement currency`, amountMinor: 4200, currency: 'USD' },
			{ note: `${NOTE_MARKER} foreign currency`, amountMinor: 120_000, currency: 'THB' },
			{ note: `${NOTE_MARKER} enormous`, amountMinor: 99_999_999, currency: 'USD' }
		];
		const created = [];
		for (const input of inputs) {
			created.push((await createCapture({ userId: s.user.id, groupId: s.group.id, input })).id);
		}
		return created;
	}

	// ── 1. §8 is blind to `captures` (PLAN §7.7, §8; ADR-0012) ─────────────────

	it('produces byte-identical balances, who-should-pay and suggestions', async () => {
		const before = await ledgerSnapshot();

		// The baseline must be NON-TRIVIAL, or "identical" would be a statement about
		// two empty groups: a real debt in each direction and a real suggestion.
		const baseline = JSON.parse(await ledgerMath()) as {
			balances: { memberId: string; balance: number }[];
			whoShouldPay: { memberId: string; balance: number }[];
			suggestions: { fromMemberId: string; toMemberId: string; amount: number }[];
		};
		expect(baseline.balances.map((b) => b.balance).sort((a, b) => a - b)).toEqual([-3000, 3000]);
		expect(baseline.whoShouldPay[0].memberId).toBe(s.bob);
		expect(baseline.suggestions).toEqual([
			{ fromMemberId: s.bob, toMemberId: s.alice, amount: 3000 }
		]);

		const captureIds = await fillWithCaptures();

		// The Captures are REALLY there — otherwise the equality below would only be
		// saying that nothing happened.
		const open = await listOpenCaptures(s.user.id, s.group.id);
		expect(open).toHaveLength(4);
		expect(open.filter((c) => c.amountMinor !== null)).toHaveLength(3);
		expect(
			(await countOpenCapturesByGroup({ userId: s.user.id, groupIds: [s.group.id] })).get(
				s.group.id
			)
		).toBe(4);

		// ACCEPTANCE: the same group with Captures produces the SAME BYTES.
		expect(await ledgerSnapshot()).toBe(before);

		// And a soft discard — the other ending (§7.7 "Edge cases") — moves nothing
		// either. A row leaving the open queue is not a ledger event.
		await discardCapture({ userId: s.user.id, groupId: s.group.id, captureId: captureIds[0] });
		expect(await ledgerSnapshot()).toBe(before);
	});

	// ── 2. `captures` is absent from the ledger PAYLOADS (§16.4, ADR-0012) ─────

	it('leaks no capture note, id or field into `/api/v1` or the MCP ledger tools', async () => {
		const captureIds = await fillWithCaptures();

		// The serialized surfaces, searched for anything a Capture could put there:
		// its author-written note, its row id, and the word itself (a field name like
		// `pendingCaptures` or `captureCount` would be caught by the last one).
		for (const [label, payload] of Object.entries({
			rest: await restSurfaces(),
			mcp: await mcpSurfaces()
		})) {
			expect(payload, label).not.toContain(NOTE_MARKER);
			expect(payload.toLowerCase(), label).not.toContain('capture');
			for (const id of captureIds) expect(payload, `${label} / ${id}`).not.toContain(id);
		}
	});

	// ── 3. Resolving is the ONLY thing that moves a balance (§7.7 "Resolving") ──

	it('moves the balances for the first time when a Capture is recorded', async () => {
		const before = await ledgerSnapshot();
		const captureIds = await fillWithCaptures();
		expect(await ledgerSnapshot()).toBe(before);

		// "Record it": the note becomes an ORDINARY transaction, validated in full by
		// §7.4 — Bob pays $42, split equally, so Alice's $30 credit narrows by $21.
		const transactionId = await recordCaptureAsTransaction({
			userId: s.user.id,
			groupId: s.group.id,
			captureId: captureIds[1],
			input: spendingInput({
				payerId: s.bob,
				beneficiaryIds: [s.alice, s.bob],
				amount: 4200,
				title: `${NOTE_MARKER} settlement currency`
			})
		});

		const after = await ledgerMath();
		expect(after).not.toBe(JSON.parse(before).math);
		const balances = (JSON.parse(after) as { balances: { memberId: string; balance: number }[] })
			.balances;
		expect(balances.find((b) => b.memberId === s.alice)?.balance).toBe(900);
		expect(balances.find((b) => b.memberId === s.bob)?.balance).toBe(-900);

		// The stamp closed the note: the tray/count drop it, and the transaction it
		// became is the one the ledger surfaces now show.
		const open = await listOpenCaptures(s.user.id, s.group.id);
		expect(open.map((c) => c.id)).not.toContain(captureIds[1]);
		expect(open).toHaveLength(3);

		const list = await apiCall<{ data: { id: string }[] }>(
			'GET',
			`/api/v1/groups/${s.group.id}/transactions`,
			{ key: s.readKey.key }
		);
		expect(list.body.data.map((t) => t.id)).toContain(transactionId);
	});

	// ── 4. The audit trail covers all three endings (PLAN §12.1) ───────────────

	it('records create, resolve and discard, and reads correctly in the activity feed', async () => {
		const captureIds = await fillWithCaptures();
		await discardCapture({ userId: s.user.id, groupId: s.group.id, captureId: captureIds[0] });
		await recordCaptureAsTransaction({
			userId: s.user.id,
			groupId: s.group.id,
			captureId: captureIds[1],
			input: spendingInput({
				payerId: s.bob,
				beneficiaryIds: [s.alice, s.bob],
				amount: 4200,
				title: `${NOTE_MARKER} settlement currency`
			})
		});

		const rows = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.groupId, s.group.id), eq(auditLog.entityType, 'capture')));

		// Four creates, one discard, one resolve — every mutation, no more.
		const actions = rows.map((r) => r.action).sort();
		expect(actions).toEqual(['create', 'create', 'create', 'create', 'discard', 'resolve']);
		// Every row is attributable (§12.1) and denormalizes the note, so the line
		// stays readable after the row is closed.
		for (const row of rows) {
			expect(row.actorUserId).toBe(s.user.id);
			expect(row.summary).toContain(NOTE_MARKER);
			// "Capture" is INTERNAL vocabulary (CONTEXT.md) — never in a stored summary.
			expect(row.summary.toLowerCase()).not.toContain('capture');
		}
		// The resolve points at the transaction the note became.
		const resolve = rows.find((r) => r.action === 'resolve');
		expect((resolve?.metadata as { transactionId?: string })?.transactionId).toBeTruthy();

		// ── `/groups/[id]/activity` — the feed the page renders (§12.1 "Visibility") ─
		const feed = await listGroupActivity({ userId: s.user.id, groupId: s.group.id });
		const captureEntries = feed.filter((e) => e.entityType === 'capture');
		expect(captureEntries).toHaveLength(6);
		// Newest first, and attributed to a resolvable name (never the raw user id).
		const times = captureEntries.map((e) => e.occurredAt);
		expect(times).toEqual([...times].sort().reverse());
		for (const entry of captureEntries) {
			expect(entry.actorName).toBe(s.user.name);
			// What the row renders (`ActivityEntryRow`): the labels, not the raw values.
			expect(entityTypeLabel(entry.entityType)).toBe('Not recorded yet');
			expect(['created', 'recorded', 'discarded']).toContain(actionLabel(entry.action));
		}

		// The entity filter offers `capture`, and selecting it returns exactly those.
		const filtered = await listGroupActivity({
			userId: s.user.id,
			groupId: s.group.id,
			filters: { entityType: 'capture' }
		});
		expect(filtered.map((e) => e.id).sort()).toEqual(captureEntries.map((e) => e.id).sort());
	});
});
