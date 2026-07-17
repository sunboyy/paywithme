// `restore_transaction` — the tool that makes ADR-0003 true (issue #35).
//
// ── This is not a nicety; it is the control ──────────────────────────────────
// ADR-0003 does not claim we can prevent a prompt-injected write. It says so plainly:
// "Prevention is not achievable; we do not pretend otherwise." What it offers instead
// is a risk appetite — a bogus write is acceptable BECAUSE it is "visible,
// attributable to a specific key, and undoable", and because "paywithme records debts;
// it does not move money" means the harm is "recoverable, attributable, and
// reversible".
//
// Every word of that rests on an undo that actually exists and that the agent can
// actually reach. `softDeleteTransaction` makes the data recoverable; THIS tool is what
// makes it recovered. Without it, "an injected write is recoverable" is a statement
// about the database schema, not about anything a user can do in the conversation where
// the problem appeared. With it, the sentence is true as written.
//
// So the smallness of this file is the point: the mechanism is one guarded UPDATE, and
// it is load-bearing for the entire injection stance.
//
// ── Non-destructive, deliberately ───────────────────────────────────────────
// `destructiveHint: false`. Restoring puts back something that was there; it removes
// nothing. `delete_transaction` is the ONLY tool on this surface that claims `true`,
// and that exclusivity is what gives the flag meaning (see `./delete-transaction`).
// A restore that gated as hard as a delete would put friction on the recovery path and
// none on the damage path — precisely backwards, given which of the two an injected
// call is likely to be.
//
// ── What this tool does NOT do ───────────────────────────────────────────────
//   - Scope + rate limit: the dispatcher (`tools.ts` → `dispatchToolCall`) ALREADY
//     denies a read key with `forbidden_scope` and consumes the WRITE rate-limit class
//     before `run` is entered. We only DECLARE `scope: 'write'` / `rateLimitClass: 'write'`.
//   - Audit: `restoreTransaction` writes the `restore` audit row (carrying `viaKey`
//     provenance from `auditVia(principal)`) in the SAME DB transaction as the update
//     (§12.1) — and ONLY on a real state transition (§16.6: restoring a live txn writes
//     no audit row). We never write audit ourselves.
//   - Idempotency: NO derived window — see `idempotentHint`.

import { z } from 'zod';
import { getTransactionDetail, restoreTransaction } from '$lib/server/transactions';
import { auditVia } from '$lib/server/api/provenance';
import { toolSuccess } from '../errors';
import { buildRestoreEchoBack, toTransactionView, UNTRUSTED_NOTE } from '../view';
import type { McpTool } from '../types';
import { GROUP_ID_PROPERTY, groupIdArg, TXN_ID_PROPERTY, txnIdArg } from './args';
import { loadGroupView, loadMemberViews } from './load';

/** The wire name. */
const TOOL_NAME = 'restore_transaction';

const restoreTransactionArgs = z.strictObject({
	groupId: groupIdArg,
	txnId: txnIdArg
});

export const restoreTransactionTool: McpTool<z.infer<typeof restoreTransactionArgs>> = {
	scope: 'write',
	rateLimitClass: 'write',
	args: restoreTransactionArgs,
	definition: {
		name: TOOL_NAME,
		title: 'Undo a deleted transaction',
		description:
			'Put back a transaction that was deleted — the undo for `delete_transaction`. Use ' +
			'this when the user says a removal was a mistake, or when a transaction they expect ' +
			'to see turns out to have been deleted. The transaction returns exactly as it was ' +
			"and counts toward everyone's balances again. IDS ONLY, NEVER NAMES: `txnId` must " +
			'come from `list_transactions` or `get_transaction`. A deleted transaction is still ' +
			'readable with `get_transaction` (it is marked `isDeleted`), so you can check what ' +
			'you are about to restore. Restoring a transaction that is not deleted is safe and ' +
			'changes nothing. The result echoes back what came back, naming the people involved.',
		inputSchema: {
			type: 'object',
			properties: {
				groupId: GROUP_ID_PROPERTY,
				txnId: TXN_ID_PROPERTY
			},
			required: ['groupId', 'txnId'],
			additionalProperties: false
		},
		annotations: {
			title: 'Undo a deleted transaction',
			readOnlyHint: false,
			// FALSE — a restore ADDS back; it takes nothing away. See the header: the flag is
			// only informative because `delete_transaction` is the only tool that claims it.
			destructiveHint: false,
			// TRUE, and honestly. `restoreTransaction` is guarded by `isNotNull(deleted_at)`:
			// restoring an already-live transaction affects ZERO rows and writes NO audit row
			// (§16.6 — "audit records state transitions only"). A repeat call genuinely has no
			// additional effect, which is what this annotation claims, and what §16.6 means by
			// "restore … already idempotent".
			//
			// No ADR-0005 derived window guards this tool, for the same reason as the delete
			// path: that window stops a retried CREATE from duplicating a transaction, and
			// there is no such thing as restoring a transaction twice. The idempotence lives
			// in the DATA (a guarded UPDATE), so it holds forever rather than for a minute —
			// which matters most here, because this is the tool a user reaches for when
			// something has already gone wrong and a retry must never be the thing that fails.
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async ({ principal }, { groupId, txnId }) => {
		// Access-checked load of the group. `loadGroupView` centralizes the conflated
		// `not_found` (absent / deleted / not-yours → ONE outcome, no existence oracle,
		// §16.5), so this write path inherits it by construction.
		await loadGroupView(principal, groupId);

		// The roster resolves member ids to (untrusted) names + `isYou` for the echo.
		const members = await loadMemberViews(principal, groupId);

		// The BEFORE state, read for ONE fact the after-state cannot tell us: was it
		// actually deleted? `deleted_at` is null either way once the service returns, so
		// without this read a no-op restore and a real one are indistinguishable — and the
		// echo would claim an undo that never happened (§16.6: a no-op is an idempotent
		// SUCCESS that transitions nothing and writes no audit row).
		//
		// It is also the access + existence gate on the TXN: access-checked and
		// group-scoped, it throws `TransactionNotFoundError` for an absent id, an id in
		// another group, and an id the caller cannot see alike → the SAME conflated
		// `not_found` (§16.5). A SOFT-DELETED txn is deliberately still returned by it —
		// that is what makes this tool reachable at all.
		//
		// A read-then-act, as on the delete path, and benign for the same reason: a race
		// costs a word of prose accuracy, never data. The `isNotNull(deleted_at)` guard is
		// atomic and the `restore` audit row is gated on rows-affected > 0 (§16.6).
		const before = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
		const wasAlreadyLive = before.deletedAt === null;

		// Restore + AUDIT in one DB transaction (§12.1). `auditVia(principal)` carries the
		// key's `viaKey` provenance into the `restore` audit row — we never write audit
		// ourselves, and the service gates that write on rows-affected > 0 (§16.6).
		await restoreTransaction({
			userId: principal.userId,
			groupId,
			txnId,
			via: auditVia(principal)
		});

		// Re-read the PERSISTED state (now with `deletedAt` back to null) and project it
		// wrapped, so the echo describes what the ledger actually holds.
		const detail = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
		const restored = toTransactionView({ detail, members, principal });

		return toolSuccess({
			// The wrapped structured view (ADR-0003) — every name and the title inside an
			// untrusted envelope, exactly as the create path ships them.
			restored,
			// Machine-readable alongside the prose: whether this call actually transitioned
			// anything, so an agent need not parse the sentence to know a repeat was a no-op.
			alreadyLive: wasAlreadyLive,
			echo: buildRestoreEchoBack({
				view: restored,
				minorUnits: detail.amountTotalSettlement,
				wasAlreadyLive
			}),
			// The prose inlines member display names and the title for legibility — so the
			// result carries the untrusted-note, marking any name/title in the payload as
			// DATA, and every one it inlines is ALSO present wrapped in `restored` (ADR-0003).
			_note: UNTRUSTED_NOTE
		});
	}
};
