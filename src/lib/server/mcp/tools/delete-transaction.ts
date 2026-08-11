// `delete_transaction` — the ONLY destructive tool in the Connector (issue #35).
//
// ── `destructiveHint: true`, and why it is exclusive ─────────────────────────
// Every other tool on this surface declares `destructiveHint: false`, and that is not
// bookkeeping — it is the whole value of this one declaring `true`. ADR-0003 lists
// "annotate tools honestly … so Claude's own approval UI gates writes and gates DELETES
// harder" as one of its three layers. A flag that is true on the tool that removes a
// transaction and false on the six that add or read one carries information; a flag set
// defensively on everything that writes carries none, and the user learns to click
// through it. `create_transaction` appends. `settle_up` appends. `update_transaction`
// corrects a row that stays. This tool takes a transaction OFF the ledger and moves
// everyone's balance — it is the one that should stop and ask.
//
// The registry test asserts the exclusivity directly, because the day a second tool
// quietly claims `true` is the day this one stops meaning anything.
//
// ── SOFT delete: the mechanism ADR-0003's risk appetite is bought with ───────
// The ADR accepts that a prompt-injected write can land, on the grounds that it is
// "visible, attributable to a specific key, and undoable". This tool is where "undoable"
// stops being a hope: `softDeleteTransaction` stamps `deleted_at` and NOTHING is
// removed — the row stays, its children stay, the audit trail outlives it (§12.1), and
// `restore_transaction` puts it back with the balances exactly as they were. The echo
// names that undo, with the id, every time.
//
// Which is also the honest reading of `destructiveHint: true` here: destructive means
// "the user loses something they had", not "the bytes are gone". A balance silently
// moving is a loss even when every row is recoverable.
//
// ── What this tool does NOT do ───────────────────────────────────────────────
//   - Scope + rate limit: the dispatcher (`tools.ts` → `dispatchToolCall`) ALREADY
//     denies a read key with `forbidden_scope` and consumes the WRITE rate-limit class
//     before `run` is entered. We only DECLARE `scope: 'write'` / `rateLimitClass: 'write'`.
//     ADR-0002's filter means a read key is never even SHOWN this tool.
//   - Audit: `softDeleteTransaction` writes the `delete` audit row (carrying `viaKey`
//     provenance from `auditVia(principal)`) in the SAME DB transaction as the stamp
//     (§12.1) — and ONLY on a real state transition (§16.6: a no-op delete writes no
//     audit row). We never write audit ourselves.
//   - Idempotency: NO derived window — see `idempotentHint`.

import { z } from 'zod';
import { softDeleteTransaction } from '$lib/server/transactions';
import { auditVia } from '$lib/server/api/provenance';
import { toolSuccess } from '../errors';
import { buildDeleteEchoBack, UNTRUSTED_NOTE } from '../view';
import type { McpTool } from '../types';
import { GROUP_ID_PROPERTY, groupIdArg, TXN_ID_PROPERTY, txnIdArg } from './args';
import { applyTransactionStateChange } from './state-change';

/** The wire name. */
const TOOL_NAME = 'delete_transaction';

const deleteTransactionArgs = z.strictObject({
	groupId: groupIdArg,
	txnId: txnIdArg
});

export const deleteTransactionTool: McpTool<z.infer<typeof deleteTransactionArgs>> = {
	scope: 'write',
	rateLimitClass: 'write',
	args: deleteTransactionArgs,
	definition: {
		name: TOOL_NAME,
		title: 'Remove a transaction',
		description:
			'Remove a transaction from the group — use this when the user says an expense should ' +
			'not be there at all (a duplicate, something recorded by mistake). To CORRECT a ' +
			'transaction that should stay, use `update_transaction` instead; deleting and ' +
			're-creating loses the original record. IDS ONLY, NEVER NAMES: `txnId` must come ' +
			'from `list_transactions` or `get_transaction` — identify the transaction the user ' +
			'means YOURSELF and show your reasoning, because deleting the wrong one changes what ' +
			'everybody owes. This is a SOFT delete: the transaction stops counting toward ' +
			"everyone's balances, and `restore_transaction` puts it back exactly as it was, so " +
			'a mistake here is recoverable. Deleting an already-deleted transaction is safe and ' +
			'changes nothing. The result echoes back what was removed, naming the people ' +
			'involved and the id needed to undo it — read it out.',
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
			title: 'Remove a transaction',
			readOnlyHint: false,
			// TRUE — the ONLY tool in this Connector that says so (ADR-0003 layer 2). See the
			// header: this is the one tool that takes something the user has off the ledger
			// and moves everyone's balance, so it is the one Claude's approval UI should gate
			// harder than a create. The flag is only useful because nothing else claims it.
			destructiveHint: true,
			// TRUE, and honestly. `softDeleteTransaction` is guarded by `isNull(deleted_at)`:
			// a second delete of an already-deleted transaction affects ZERO rows, keeps the
			// original delete time, and writes NO second audit row (§16.6 — "audit records
			// state transitions only"). Repeating the call genuinely has no additional effect,
			// which is exactly what this annotation claims — and what §16.6 means by "DELETE …
			// already idempotent".
			//
			// This is why no ADR-0005 derived window guards this tool, unlike the create path.
			// That window exists to stop a retried create from DUPLICATING a transaction;
			// there is no such thing as deleting a transaction twice, so a window would guard
			// nothing while adding a way for a legitimate second call to fail as a phantom
			// "replay". The idempotence here is in the DATA (a guarded UPDATE), which is
			// stronger than a 60-second window: it holds forever, not for a minute.
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async ({ principal }, { groupId, txnId }) => {
		// The shared delete/restore flow (`./state-change`): group gate → before-state
		// read → the guarded service call → a re-read of the persisted result, wrapped.
		// Soft-delete + AUDIT happen in one DB transaction (§12.1); `auditVia(principal)`
		// carries the key's `viaKey` provenance into the `delete` audit row — we never
		// write audit ourselves, and the service gates that write on rows-affected > 0.
		const {
			view: deleted,
			wasDeleted: wasAlreadyDeleted,
			minorUnits
		} = await applyTransactionStateChange(principal, groupId, txnId, () =>
			softDeleteTransaction({
				userId: principal.userId,
				groupId,
				txnId,
				via: auditVia(principal)
			})
		);

		return toolSuccess({
			// The wrapped structured view (ADR-0003) — every name and the title inside an
			// untrusted envelope, exactly as the create path ships them.
			deleted,
			// Machine-readable alongside the prose: whether this call actually transitioned
			// anything, so an agent need not parse the sentence to know a repeat was a no-op.
			alreadyDeleted: wasAlreadyDeleted,
			echo: buildDeleteEchoBack({ view: deleted, minorUnits, wasAlreadyDeleted }),
			// The prose inlines member display names and the title for legibility — so the
			// result carries the untrusted-note, marking any name/title in the payload as
			// DATA, and every one it inlines is ALSO present wrapped in `deleted` (ADR-0003).
			_note: UNTRUSTED_NOTE
		});
	}
};
