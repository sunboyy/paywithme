// `create_capture` — *"note in the trip group that I paid for dinner, about 1,200
// baht, I'll split it later"* (issue #52; PLAN §7.7, ADR-0012).
//
// ── Why this tool exists at all ──────────────────────────────────────────────
// The friction §7.7 is fighting is REACHING FOR THE APP. You are leaving the
// restaurant; a form that wants a category, a split mode, payers and beneficiaries
// does not get filled in, and by the time there is time, the memory is gone. The
// Connector is therefore the FASTEST path to a record-later note (ADR-0012, "the
// fastest capture path is the Connector, not the form") — one spoken sentence on the
// walk out, no screen at all.
//
// ── The shallowness is what makes it safe to hand an agent ───────────────────
// There is no split for the model to get wrong. No payer, no beneficiary, no split
// mode, no rate, no items — the arguments are a note, an optional amount, and a
// date. The single wrong-person failure mode the ledger write tools spend most of
// their code defending against (ADR-0006 / ADR-0015) simply cannot occur here,
// because nobody is named. What CAN go wrong is the money (ADR-0004) and the group,
// and both are answered by the echo.
//
// ── NOTHING HERE TOUCHES THE LEDGER (§7.7, ADR-0012) ─────────────────────────
// This writes a `captures` row. No transaction, no balance, no settlement
// equivalent, no rate. `get_balances`, `list_transactions` and every other tool on
// this surface stay blind to it, by construction: the dependency runs one way, and
// this module imports nothing from `$lib/server/transactions`.
//
// ── Money: a DECIMAL STRING, the server does the exponent math (ADR-0004) ────
// `amount` is `"1200"` / `"1200.00"`, never a float and never minor units, and the
// model never multiplies by 100. `parseAmount` reads the exponent off the currency
// (2 for THB, 0 for JPY) and rejects more decimal places than that currency allows
// as a HARD error — `"1200.005"` in THB is refused, never silently rounded.
//
// UNLIKE `create_transaction`, the currency is NOT restricted to the group's
// settlement currency, and that difference is deliberate rather than an oversight.
// The restriction there exists because a foreign entry currency needs an EXCHANGE
// RATE and an assistant has no rate source. A note converts nothing — §7.7 says the
// amount and currency "stay uninterpreted: no rate, no conversion, no settlement
// equivalent" — so there is nothing to defer. Refusing "3,000 yen" in a THB group
// would leave the agent two bad options at the exact moment speed is the whole
// point: record ฿3,000 (wrong, and later prefilled into a real transaction), or
// nothing at all. The web quick-capture form already offers the group's full
// currency set for the same reason.
//
// Only the 29 SEEDED codes are accepted. A group-defined custom currency is stored
// under an opaque `cur_…` key the agent has never seen and must never be told about
// (ADR-0014 decision 7), so a code that is not seeded is a plain validation_error.
//
// ── What this tool does NOT do ───────────────────────────────────────────────
//   - Scope + rate limit: the dispatcher denies a READ key with `forbidden_scope`
//     and consumes the WRITE class before `run` is entered (ADR-0002). We only
//     DECLARE `scope: 'write'`.
//   - Audit: `createCapture` writes the `audit_log` row in the SAME DB transaction
//     as the insert (§12.1), carrying `auditVia(principal)` provenance.
//   - Validate the note/date/currency itself beyond shape: the SHARED
//     `buildCreateCaptureSchema` (which the web form uses) is the one authority, so
//     the two entry points cannot drift. This tool lets `createCapture` run that
//     schema and re-labels its field paths into its own argument names; it never
//     restates its rules.
//
// ── Idempotency (§16.6, ADR-0005) — the guard, without the peek ──────────────
// The write is routed through the same server-derived ~60s sliding window every
// other MCP write uses (`../idempotency`): the agent cannot mint an
// `Idempotency-Key`, so the server derives one from (key + group + tool + arguments
// + window). A content-identical retry REPLAYS and says so; the same note an hour
// later is a new row, as it must be.
//
// It does NOT call `peekIdempotentReplay` first, and that is a considered omission.
// That pre-check exists for one reason: since ADR-0015 the ledger tools resolve
// member NAMES, and a rename between an original success and a plain retry could
// make validation reject a call that already succeeded — so the replay has to be
// found BEFORE validation runs. A note names nobody. Its validation reads only the
// arguments and the calendar, so a retry that validated once validates again, and
// the guard below is reached identically. Adding the peek would be two extra
// queries buying a case that cannot arise.

import { z } from 'zod';
import { parseAmount, SEEDED_CURRENCY_DESCRIPTORS, type CurrencyDescriptor } from '$lib/money';
import { CAPTURE_NOTE_MAX_LENGTH } from '$lib/schemas/capture';
import { createCapture, CaptureValidationError } from '$lib/server/captures';
import { resolveEntryCurrency } from '$lib/server/entry-currency';
import { auditVia } from '$lib/server/api/provenance';
import { createDbIdempotencyStore, type IdempotentResponse } from '$lib/server/api/idempotency';
import { toolError, toolSuccess } from '../errors';
import { withDerivedIdempotency } from '../idempotency';
import {
	buildCaptureEchoBack,
	buildCaptureReplayEchoBack,
	toCaptureView,
	UNTRUSTED_NOTE,
	type CaptureView,
	type UntrustedText
} from '../view';
import type { McpTool } from '../types';
import { amountArg, GROUP_ID_PROPERTY, groupIdArg } from './args';
import { loadAuthorNames, loadGroupView } from './load';

/** The wire name — shared by the definition and the derived idempotency key. */
const TOOL_NAME = 'create_capture';

/**
 * The payload a successful write produces, and the one a REPLAY reads back out of
 * the idempotency store. Every field is JSON-scalar, so the `jsonb` round-trip is
 * lossless and a replay reconstructs the same wrapped view (ADR-0003).
 */
interface NotedPayload {
	noted: CaptureView;
	/**
	 * The group the note landed in, WRAPPED (ADR-0003). The echo inlines this name as
	 * a bare substring for legibility, which is legal only because the same string
	 * also rides here, attributed, under `UNTRUSTED_NOTE`.
	 */
	group: { id: string; name: UntrustedText };
	echo: string;
	_note: string;
}

const createCaptureArgs = z.strictObject({
	groupId: groupIdArg,
	// The ONLY required content (§7.7). Capped at the same length the shared schema
	// caps it at — a note the transaction TITLE field would reject is a note that
	// cannot be recorded later on its own words.
	note: z
		.string()
		.trim()
		.min(1, 'A note is required — say what the spending was, in the user’s own words.')
		.max(CAPTURE_NOTE_MAX_LENGTH, `Note must be ${CAPTURE_NOTE_MAX_LENGTH} characters or fewer.`),
	// OPTIONAL money, as one fact: an amount without a currency cannot be rendered at
	// all (the exponent decides where the point goes) and a currency without an amount
	// states nothing. The shared schema enforces the pairing; this tool defaults the
	// currency to the group's settlement currency so the common case needs neither.
	amount: amountArg.optional(),
	currency: z.string().min(1).optional(),
	// OPTIONAL real-world day, defaulting to today. Backdating is the point: "I paid
	// for Saturday's dinner" on Tuesday is the ordinary case (§7.1 / §7.7).
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be a calendar day in YYYY-MM-DD form.')
		.optional()
});

export const createCaptureTool: McpTool<z.infer<typeof createCaptureArgs>> = {
	scope: 'write',
	rateLimitClass: 'write',
	args: createCaptureArgs,
	definition: {
		name: TOOL_NAME,
		title: 'Note a spending to record later',
		description:
			'Note that a shared spending HAPPENED, without recording it — for when the user ' +
			'cannot give the details yet ("I paid for dinner, about 1,200 baht, I\'ll split it ' +
			'later"). This does NOT create a transaction and changes NO balance: it leaves a ' +
			'"not recorded yet" note that everyone in the group can see, so the same expense ' +
			'does not get entered twice, and so it can be recorded properly later. Use ' +
			'`create_transaction` INSTEAD whenever the user has told you enough to record the ' +
			'real thing (who paid and who it is split between) — reach for this only when they ' +
			"haven't, or when they say they will sort it out later. Everything is optional " +
			"except the group and the `note`: write the note in the user's own words. State the " +
			'`amount` as a DECIMAL STRING exactly as the user said it ("1200", "1200.00") — the ' +
			'server does the currency math, so never multiply by 100 or convert exponents — and ' +
			'`currency` may be ANY ISO-4217 code from `list_currencies` (nothing is converted, ' +
			"so a foreign amount is fine here), defaulting to the group's settlement currency. " +
			'`date` is the day the spending happened, defaulting to today. The result echoes ' +
			'back what was noted, naming the group and restating the amount — read it out, and ' +
			'be clear with the user that the expense is still NOT RECORDED. If a call seems to ' +
			'have failed, an identical retry within about a minute is de-duplicated rather than ' +
			'noted twice, and the result will say so.',
		inputSchema: {
			type: 'object',
			properties: {
				groupId: GROUP_ID_PROPERTY,
				note: {
					type: 'string',
					minLength: 1,
					maxLength: CAPTURE_NOTE_MAX_LENGTH,
					description:
						'REQUIRED. What the spending was, in the user’s own words ("dinner at the izakaya"). ' +
						'Everyone in the group sees it, and it becomes the title when the transaction is ' +
						'recorded later, so keep it descriptive rather than writing "expense".'
				},
				amount: {
					type: 'string',
					description:
						'OPTIONAL approximate amount, as a DECIMAL STRING stated exactly as the user said ' +
						'it: "1200", "1200.00". No currency symbol, no thousands separators, no negative ' +
						'sign. The server converts to minor units, so do NOT do that math yourself. Omit ' +
						'it entirely if the user did not say an amount — a note without one is normal.'
				},
				currency: {
					type: 'string',
					description:
						'OPTIONAL ISO-4217 code for `amount` (from `list_currencies`). Defaults to the ' +
						"group's settlement currency. Unlike a recorded transaction, a foreign currency " +
						'is accepted here: nothing is converted and this amount is in no balance. Pass it ' +
						'only alongside an `amount`.'
				},
				date: {
					type: 'string',
					description:
						'OPTIONAL day the spending happened, as YYYY-MM-DD. Defaults to today; cannot be ' +
						'in the future. Use it when the user says "Saturday" or "yesterday".'
				}
			},
			required: ['groupId', 'note'],
			additionalProperties: false
		},
		annotations: {
			title: 'Note a spending to record later',
			// It WRITES (a `captures` row), so it is not read-only — but it is the least
			// consequential write on the surface: it appends a note, deletes nothing,
			// overwrites nothing, and moves no money.
			readOnlyHint: false,
			destructiveHint: false,
			// FALSE for the same reason every other write says false: the ~60s window is a
			// BOUNDED guarantee, and the annotation claims an unbounded one. Two notes about
			// two different dinners on the same day is a real thing.
			idempotentHint: false,
			openWorldHint: false
		}
	},
	run: async ({ principal }, rawArgs) => {
		const { groupId, note, amount, currency, date } = rawArgs;

		// Access-checked load of the group — and the settlement currency the amount
		// defaults to. `loadGroupView` centralizes the conflated `not_found` (absent /
		// deleted / not-yours → ONE outcome, no existence oracle, §16.5), so this write
		// path inherits it by construction.
		const group = await loadGroupView(principal, groupId);

		// ── The money, both-or-neither (§7.7) ──────────────────────────────────────
		// A bare `currency` states nothing a note doesn't already imply, and the shared
		// schema would reject it. Say so here, where the message can name the ARGUMENT
		// the agent actually sent rather than the internal field name.
		if (amount === undefined && currency !== undefined) {
			return toolError(
				'validation_error',
				'A `currency` without an `amount` says nothing. Pass both, or neither.',
				{ fieldErrors: { amount: ['Pass an amount alongside the currency, or omit both.'] } }
			);
		}

		let money: { amountMinor: number; descriptor: CurrencyDescriptor } | undefined;
		if (amount !== undefined) {
			// Only the seeded 29 (see the header): a group-defined currency lives under an
			// opaque key the agent has never seen and must not be handed one, so the lookup
			// is deliberately over the COMPILED-IN descriptors and never touches the
			// `currencies` table.
			const code = currency ?? group.settlementCurrency;
			const descriptor = SEEDED_CURRENCY_DESCRIPTORS.find((c) => c.code === code);
			if (descriptor === undefined) {
				return toolError(
					'validation_error',
					`${code} is not a currency this app knows. Call \`list_currencies\` for the codes ` +
						`you can use, or omit \`currency\` to use this group's own (${group.settlementCurrency}).`,
					{ fieldErrors: { currency: [`Unknown currency code: ${code}.`] } }
				);
			}
			// ADR-0004: the exponent math happens HERE, on the server, in the module that
			// owns it. More decimal places than this currency allows is a HARD error.
			try {
				money = { amountMinor: parseAmount(amount, descriptor), descriptor };
			} catch (err) {
				const message = err instanceof Error ? err.message : 'The amount could not be parsed.';
				return toolError('validation_error', message, { fieldErrors: { amount: [message] } });
			}
		}

		// What the SHARED schema (`buildCreateCaptureSchema`) will parse. `capturedFor` is
		// omitted rather than defaulted here so the schema's own `todayUtc()` default is
		// the single authority on "today".
		const input = {
			note,
			...(money ? { amountMinor: money.amountMinor, currency: money.descriptor.code } : {}),
			...(date !== undefined ? { capturedFor: date } : {})
		};

		// ── The WRITE, guarded by the server-derived ~60s window (ADR-0005) ────────
		// A `write` the service rejects frees its key, so the agent's corrected retry meets
		// a clean path. The key is derived from the RAW
		// arguments — "did the model already send me exactly this?" — so an explicit
		// `currency` never collides with an omitted one.
		const { response, replayedAfterMs } = await withDerivedIdempotency({
			keyId: principal.keyId,
			groupId,
			toolName: TOOL_NAME,
			args: rawArgs,
			store: createDbIdempotencyStore(),
			write: async () => {
				// Insert + AUDIT in one DB transaction (§12.1). `auditVia(principal)` carries the
				// key's `viaKey` provenance into the audit row — we never write audit ourselves.
				try {
					return await createCapture({
						userId: principal.userId,
						groupId,
						input,
						via: auditVia(principal)
					});
				} catch (err) {
					// The service's rejection is re-labelled into the tool's own vocabulary —
					// `date`, not `capturedFor` (ADR-0009).
					throw err instanceof CaptureValidationError ? relabelIssues(err) : err;
				}
			},
			respond: async (capture) => {
				// The author is the caller by construction (`createdBy` is server-derived), so
				// the roster is read only for the DISPLAY NAME the view attributes the note to —
				// the same name the rest of the group will read it under in `list_captures`.
				// Read INSIDE `respond`, so a replay does not pay for it.
				const authorNames = await loadAuthorNames(principal, groupId);
				// The view takes the resolved `currencies` ROW, because a CUSTOM currency's
				// code, name and symbol are member-authored and must ride wrapped beside the
				// amount (ADR-0003). This tool accepts SEEDED codes only, so the companion is
				// always absent here — but the resolution goes through the one shared path
				// rather than a hand-built row, and a seeded code costs NO query
				// (`lib/server/entry-currency.ts`, the compiled-in fast path).
				const entryCurrency = money
					? await resolveEntryCurrency(groupId, money.descriptor.code)
					: undefined;
				const noted = toCaptureView({
					capture,
					principal,
					authorName: authorNames.get(principal.userId) ?? null,
					currency: entryCurrency
				});

				const payload: NotedPayload = {
					noted,
					group: { id: group.id, name: group.name },
					echo: buildCaptureEchoBack({
						groupName: group.name.value,
						view: noted,
						minorUnits: money?.amountMinor ?? null
					}),
					// The prose inlines the group name and the note for legibility; both ride
					// wrapped above, and this marks every such string as DATA (ADR-0003).
					_note: UNTRUSTED_NOTE
				};
				// `status` is the REST store's shape (§16.6); MCP has no HTTP status for a tool
				// result, so it is a fixed 200 and only `body` is ever read back on this path.
				return { status: 200, body: payload };
			}
		});

		// The ordinary path: noted, exactly once.
		if (replayedAfterMs === null) {
			return toolSuccess({ ...(response.body as NotedPayload), replayed: false });
		}

		// A REPLAY: the window absorbed a retry. A SUCCESS — the user's intent (ONE note
		// in the tray) holds — but told PLAINLY, so the agent cannot report a second note
		// that does not exist. The wrapped view still ships; only the leading prose
		// changes, and `replayed` states it machine-readably.
		return replaySuccess({ response, replayedAfterMs });
	}
};

/** The REPLAY response shape — the wrapped view, with the prose that says it replayed. */
function replaySuccess({
	response,
	replayedAfterMs
}: {
	response: IdempotentResponse;
	replayedAfterMs: number;
}) {
	const payload = response.body as NotedPayload;
	return toolSuccess({
		...payload,
		replayed: true,
		notedAgoSeconds: Math.round(replayedAfterMs / 1000),
		echo: buildCaptureReplayEchoBack({ notedEcho: payload.echo, replayedAfterMs })
	});
}

/** The shared schema's field names → this tool's argument names. */
const ISSUE_PATH_ALIASES: Record<string, string> = {
	capturedFor: 'date',
	amountMinor: 'amount'
};

/**
 * Rewrite a `CaptureValidationError`'s issue paths into the tool's own vocabulary.
 *
 * The service validates `capturedFor` / `amountMinor`; the agent sent `date` /
 * `amount`. Reporting the internal names would name a field the model cannot find in
 * the schema it was given — which is the difference between a self-correctable error
 * and a confusing one (ADR-0009).
 */
function relabelIssues(error: CaptureValidationError): CaptureValidationError {
	return new CaptureValidationError(
		error.issues.map((issue) => {
			const [first, ...rest] = issue.path ?? [];
			const alias = typeof first === 'string' ? ISSUE_PATH_ALIASES[first] : undefined;
			return alias === undefined ? issue : { ...issue, path: [alias, ...rest] };
		}),
		error.message
	);
}
