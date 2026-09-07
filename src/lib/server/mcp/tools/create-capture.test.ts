// Unit tests for `create_capture` (#52) — the SCOPE gate, the ADR-0004 decimal-string
// money contract, the untrusted envelope, and the echo-back's wording.
//
// Everything runs through the REAL dispatcher (`dispatchToolCall`) against the REAL
// registry, so each test exercises what an agent would actually hit: the ADR-0002
// scope check, the tool's own Zod schema, and the ADR-0009 error mapping. Only the
// edges are mocked — the group/roster reads, the capture SERVICE (proved by its own
// suites; what we assert here is what we ASK it to do), and the idempotency guard,
// which is stubbed to run its `fn` so these tests can pin the toolName and the RAW
// arguments it is keyed on (that mechanism has its own suite, #33).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scopeToPermissions } from '$lib/server/api/scope';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { Capture } from '$lib/server/captures';
import type { Group } from '$lib/server/groups';
import type { MemberListItem } from '$lib/server/members';
import type { McpToolResult } from '../types';

const { getGroupForUser, listMembers, createCapture, consumeRateLimit, withDerivedIdempotency } =
	vi.hoisted(() => ({
		getGroupForUser: vi.fn(),
		listMembers: vi.fn(),
		createCapture: vi.fn(),
		consumeRateLimit: vi.fn(),
		withDerivedIdempotency: vi.fn()
	}));

vi.mock('$lib/server/groups', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/groups')>()),
	getGroupForUser
}));
vi.mock('$lib/server/members', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/members')>()),
	listMembers
}));
vi.mock('$lib/server/captures', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/captures')>()),
	createCapture
}));
vi.mock('$lib/server/api/rate-limit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/api/rate-limit')>()),
	consumeRateLimit
}));
vi.mock('../idempotency', async (importOriginal) => ({
	...(await importOriginal<typeof import('../idempotency')>()),
	withDerivedIdempotency
}));
// The store is a DB handle the stubbed guard never uses.
vi.mock('$lib/server/api/idempotency', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/api/idempotency')>()),
	createDbIdempotencyStore: () => ({}) as never
}));

// Imported AFTER the mocks are registered.
import { CaptureValidationError } from '$lib/server/captures';
import { dispatchToolCall } from '../tools';

const GROUP_ID = 'grp_1';

function principalWith(scope: 'read' | 'write'): ApiKeyPrincipal {
	return {
		keyId: 'key_1',
		name: 'trip key',
		userId: 'user_me',
		permissions: scopeToPermissions(scope)
	};
}

/** A THB group whose name is MEMBER-AUTHORED text the echo will inline. */
function group(settlementCurrency = 'THB'): Group {
	return {
		id: GROUP_ID,
		name: 'Japan Trip',
		settlementCurrency,
		createdBy: 'user_me',
		createdAt: new Date('2026-07-01T00:00:00.000Z'),
		updatedAt: new Date('2026-07-01T00:00:00.000Z'),
		deletedAt: null
	} as unknown as Group;
}

const ROSTER: MemberListItem[] = [
	{ id: 'mem_me', displayName: 'Sur', userId: 'user_me', deactivatedAt: null, isLinked: true },
	{ id: 'mem_nan', displayName: 'Nan', userId: 'user_nan', deactivatedAt: null, isLinked: true }
];

/** The row `createCapture` returns — built from the input the tool actually sent. */
function storedCapture(input: {
	note: string;
	amountMinor?: number;
	currency?: string;
	capturedFor?: string;
}): Capture {
	return {
		id: 'cap_1',
		groupId: GROUP_ID,
		createdBy: 'user_me',
		note: input.note,
		amountMinor: input.amountMinor ?? null,
		currency: input.currency ?? null,
		capturedFor: input.capturedFor ?? '2026-09-08',
		resolvedTransactionId: null,
		resolvedAt: null,
		discardedAt: null,
		createdAt: new Date('2026-09-08T09:30:00.000Z')
	};
}

/** Call the tool the way a client does — through the dispatcher and the registry. */
async function call(args: Record<string, unknown>, scope: 'read' | 'write' = 'write') {
	const outcome = await dispatchToolCall(
		{ name: 'create_capture', arguments: args },
		principalWith(scope)
	);
	if (outcome.kind !== 'result') throw new Error('expected a tool result');
	return outcome.result;
}

function payloadOf(result: McpToolResult) {
	return JSON.parse(result.content[0].text);
}

function envelopeOf(result: McpToolResult): { code: string; message: string; details?: unknown } {
	return payloadOf(result).error;
}

/** What the tool asked the SERVICE to store, on the last (only) call. */
function serviceInput(): {
	note: string;
	amountMinor?: number;
	currency?: string;
	capturedFor?: string;
} {
	return createCapture.mock.calls[0][0].input;
}

beforeEach(() => {
	vi.clearAllMocks();
	consumeRateLimit.mockResolvedValue({
		allowed: true,
		count: 1,
		lastRequest: Date.now(),
		retryAfterMs: 0
	});
	getGroupForUser.mockResolvedValue(group());
	listMembers.mockResolvedValue(ROSTER);
	createCapture.mockImplementation(async ({ input }: { input: Record<string, unknown> }) =>
		storedCapture(input as Parameters<typeof storedCapture>[0])
	);
	// Run the guarded write for real; the window mechanism is #33's own suite.
	withDerivedIdempotency.mockImplementation(
		async ({ fn }: { fn: () => Promise<{ status: number; body: unknown }> }) => ({
			response: await fn(),
			replayedAfterMs: null
		})
	);
});

describe('the scope gate (ADR-0002 / ADR-0009)', () => {
	it('a READ key is REFUSED — forbidden_scope, and nothing is written', async () => {
		const result = await call({ groupId: GROUP_ID, note: 'dinner' }, 'read');

		expect(result.isError).toBe(true);
		const envelope = envelopeOf(result);
		expect(envelope.code).toBe('forbidden_scope');
		// ADR-0009's guidance: a read key retrying will never succeed.
		expect(envelope.message).toMatch(/read-only/i);
		expect(createCapture).not.toHaveBeenCalled();
		// A denied call costs no rate budget either — the scope check runs first.
		expect(consumeRateLimit).not.toHaveBeenCalled();
	});

	it('a WRITE key may call it', async () => {
		const result = await call({ groupId: GROUP_ID, note: 'dinner' });

		expect(result.isError).toBeUndefined();
		expect(createCapture).toHaveBeenCalledTimes(1);
	});
});

describe('the amount is a DECIMAL STRING and the SERVER does the exponent math (ADR-0004)', () => {
	it('"1200" in a THB group is stored as 120000 minor units', async () => {
		await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200' });

		expect(serviceInput()).toMatchObject({ amountMinor: 120000, currency: 'THB' });
	});

	it('"1200.00" and "1200" mean the same thing', async () => {
		await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200.00' });

		expect(serviceInput().amountMinor).toBe(120000);
	});

	it('a 0-decimal currency does NO multiplication: "3000" JPY is 3000 minor units', async () => {
		// The exact failure ADR-0004 exists to stop is exponent arithmetic done by the
		// model — which is only visibly wrong when the exponent VARIES. In JPY, 3000 major
		// units are 3000 minor units; in THB the same string is 300000.
		await call({ groupId: GROUP_ID, note: 'ramen', amount: '3000', currency: 'JPY' });

		expect(serviceInput()).toMatchObject({ amountMinor: 3000, currency: 'JPY' });
	});

	it('MORE DECIMAL PLACES than the currency allows is a HARD error, never a silent round', async () => {
		const result = await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200.005' });

		expect(result.isError).toBe(true);
		const envelope = envelopeOf(result);
		expect(envelope.code).toBe('validation_error');
		expect(envelope.message).toMatch(/too many decimal places for THB/i);
		// And nothing was written — a rejected amount must not leave a note behind.
		expect(createCapture).not.toHaveBeenCalled();
	});

	it('ANY fractional digit is rejected for a 0-decimal currency', async () => {
		const result = await call({
			groupId: GROUP_ID,
			note: 'ramen',
			amount: '3000.5',
			currency: 'JPY'
		});

		expect(envelopeOf(result).message).toMatch(/too many decimal places for JPY/i);
		expect(createCapture).not.toHaveBeenCalled();
	});

	it.each(['1,200', '-1200', '฿1200', '1200.5000000', 'about 1200'])(
		'refuses `%s` at the tool schema — no symbols, separators, negatives or prose',
		async (amount) => {
			const result = await call({ groupId: GROUP_ID, note: 'dinner', amount });

			expect(result.isError).toBe(true);
			expect(envelopeOf(result).code).toBe('validation_error');
			expect(createCapture).not.toHaveBeenCalled();
		}
	);

	it('a FOREIGN currency is accepted — a note converts nothing (§7.7)', async () => {
		// Deliberately UNLIKE `create_transaction`, which is settlement-only because a
		// foreign entry currency needs an exchange rate. Nothing here is converted, so
		// there is no rate to need and no reason to refuse the user's own words.
		await call({ groupId: GROUP_ID, note: 'ramen', amount: '3000', currency: 'JPY' });

		expect(serviceInput().currency).toBe('JPY');
	});

	it('a group-defined or unknown currency code is a self-correctable validation_error', async () => {
		const result = await call({
			groupId: GROUP_ID,
			note: 'beers',
			amount: '3',
			currency: 'cur_9f2e'
		});

		expect(envelopeOf(result).code).toBe('validation_error');
		expect(envelopeOf(result).message).toMatch(/list_currencies/);
		expect(createCapture).not.toHaveBeenCalled();
	});

	it('a `currency` with no `amount` is refused, naming the ARGUMENT the agent sent', async () => {
		const result = await call({ groupId: GROUP_ID, note: 'dinner', currency: 'THB' });

		const envelope = envelopeOf(result);
		expect(envelope.code).toBe('validation_error');
		expect(envelope.message).toMatch(/without an `amount`/i);
		expect(createCapture).not.toHaveBeenCalled();
	});

	it('an amount with NO currency defaults to the group’s settlement currency', async () => {
		await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200' });

		expect(serviceInput().currency).toBe('THB');
	});

	it('a note with NO amount stores neither field — the ordinary case (§7.7)', async () => {
		await call({ groupId: GROUP_ID, note: 'dinner' });

		expect(serviceInput()).toEqual({ note: 'dinner' });
	});
});

describe('the date (§7.1 / §7.7)', () => {
	it('is passed through as the real-world day when given', async () => {
		await call({ groupId: GROUP_ID, note: 'dinner', date: '2026-09-05' });

		expect(serviceInput().capturedFor).toBe('2026-09-05');
	});

	it('is OMITTED when absent, so the shared schema’s "today" stays the one authority', async () => {
		await call({ groupId: GROUP_ID, note: 'dinner' });

		expect(serviceInput()).not.toHaveProperty('capturedFor');
	});

	it('a non-calendar-day string is refused at the tool boundary', async () => {
		const result = await call({ groupId: GROUP_ID, note: 'dinner', date: 'last Saturday' });

		expect(envelopeOf(result).code).toBe('validation_error');
		expect(createCapture).not.toHaveBeenCalled();
	});

	it('a rejection from the SHARED schema is re-labelled onto the argument the agent sent', async () => {
		// The service validates `capturedFor`; the model sent `date`. Reporting the
		// internal name would name a field it cannot find in its own schema (ADR-0009).
		createCapture.mockRejectedValueOnce(
			new CaptureValidationError([
				{ code: 'custom', path: ['capturedFor'], message: 'The date cannot be in the future' }
			] as never)
		);

		const result = await call({ groupId: GROUP_ID, note: 'dinner', date: '2030-01-01' });

		expect(result.isError).toBe(true);
		const details = envelopeOf(result).details as { fieldErrors: Record<string, string[]> };
		expect(details.fieldErrors.date).toEqual(['The date cannot be in the future']);
		expect(details.fieldErrors).not.toHaveProperty('capturedFor');
	});
});

describe('the ECHO-BACK (CONTEXT.md "Echo-back", ADR-0004 / ADR-0006)', () => {
	it('names the GROUP and restates the amount AS INTERPRETED, ending "not recorded yet"', async () => {
		const result = await call({
			groupId: GROUP_ID,
			note: 'dinner',
			amount: '1200',
			date: '2026-09-05'
		});

		const { echo } = payloadOf(result);
		expect(echo).toContain('Noted in Japan Trip');
		expect(echo).toContain('"dinner"');
		// The decimal string AND the stored minor units, so a misparse (฿12.00 for "1200
		// baht") is visible in the sentence rather than buried in the row.
		expect(echo).toContain('THB 1200.00 (120000 minor units)');
		expect(echo).toContain('dated 2026-09-05');
		expect(echo).toMatch(/not recorded yet/);
		expect(echo).toMatch(/nothing has been added to anyone's balance/i);
	});

	it('says NOTHING about a transaction when there is no amount', async () => {
		const { echo } = payloadOf(await call({ groupId: GROUP_ID, note: 'dinner' }));

		expect(echo).toContain('Noted in Japan Trip: "dinner"');
		expect(echo).not.toMatch(/minor units/);
		expect(echo).toMatch(/not recorded yet/);
	});

	it('never says "capture" — that noun is INTERNAL vocabulary (§7.7 / CONTEXT.md)', async () => {
		const result = await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200' });
		const payload = payloadOf(result);

		expect(payload.echo).not.toMatch(/capture/i);
		expect(payload._note).not.toMatch(/capture/i);
	});

	it('a REPLAY says the note was already added, and does NOT claim a second one', async () => {
		withDerivedIdempotency.mockImplementationOnce(
			async ({ fn }: { fn: () => Promise<{ status: number; body: unknown }> }) => ({
				response: await fn(),
				replayedAfterMs: 3000
			})
		);

		const payload = payloadOf(await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200' }));

		expect(payload.replayed).toBe(true);
		expect(payload.notedAgoSeconds).toBe(3);
		expect(payload.echo).toMatch(/already added 3 seconds ago/i);
		expect(payload.echo).toMatch(/did not duplicate it/i);
		// The original restatement rides along verbatim — the user still reads what stands.
		expect(payload.echo).toContain('Noted in Japan Trip: "dinner"');
		// And it must NOT borrow the ledger echo's "it is on the ledger exactly once".
		expect(payload.echo).not.toMatch(/ledger/i);
	});
});

describe('the untrusted envelope and attribution (ADR-0003 / ADR-0006)', () => {
	it('wraps the note, attributes it to YOU, and wraps the group name the echo inlines', async () => {
		const payload = payloadOf(await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200' }));

		expect(payload.noted.note).toEqual({
			_untrusted: true,
			value: 'dinner',
			author: { kind: 'you', userId: 'user_me' }
		});
		// The author's member name — what makes the note readable to the REST of the group
		// (§7.7's deduplication) — is wrapped too, with the author the domain records for a
		// display name: nobody.
		expect(payload.noted.notedBy).toEqual({
			_untrusted: true,
			value: 'Sur',
			author: { kind: 'unknown' }
		});
		expect(payload.noted.isYours).toBe(true);
		// The echo inlines the group name as a bare substring; it is legal only because the
		// same string also rides WRAPPED here, under the untrusted note.
		expect(payload.group.name).toEqual({
			_untrusted: true,
			value: 'Japan Trip',
			author: { kind: 'you', userId: 'user_me' }
		});
		expect(payload._note).toMatch(/_untrusted/);
	});

	it('carries NO custom-currency companion — this tool accepts SEEDED codes only', async () => {
		// The companion exists to wrap a MEMBER-AUTHORED code and symbol (ADR-0003), and an
		// ISO currency has neither. Its absence here is the same signal it is on the read
		// side: "an ISO currency, as always".
		const payload = payloadOf(await call({ groupId: GROUP_ID, note: 'dinner', amount: '1200' }));

		expect(payload.noted).not.toHaveProperty('customCurrency');
		expect(payload.noted.amount).not.toHaveProperty('isCustom');
	});

	it('projects the amount as a decimal string, with no settlement equivalent (§7.7)', async () => {
		const payload = payloadOf(
			await call({ groupId: GROUP_ID, note: 'ramen', amount: '3000', currency: 'JPY' })
		);

		expect(payload.noted.amount).toMatchObject({ amount: '3000', currency: 'JPY' });
		// A Capture is NEVER converted: no rate, no settlement figure, no balance effect.
		expect(JSON.stringify(payload.noted)).not.toMatch(/settlement/i);
	});
});

describe('what the tool asks of the services', () => {
	it('writes as the CALLER, in the group from the arguments, with key provenance (§12.1 / §16.2)', async () => {
		await call({ groupId: GROUP_ID, note: 'dinner' });

		expect(createCapture).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user_me',
				groupId: GROUP_ID,
				via: { kind: 'key', keyId: 'key_1', keyName: 'trip key' }
			})
		);
	});

	it('keys the idempotency window on the tool name and the RAW arguments (ADR-0005)', async () => {
		const args = { groupId: GROUP_ID, note: 'dinner', amount: '1200' };
		await call(args);

		expect(withDerivedIdempotency).toHaveBeenCalledWith(
			expect.objectContaining({
				keyId: 'key_1',
				groupId: GROUP_ID,
				toolName: 'create_capture',
				args
			})
		);
	});

	it('a group the caller cannot see is the CONFLATED not_found — no existence oracle', async () => {
		getGroupForUser.mockResolvedValueOnce(null);

		const result = await call({ groupId: 'grp_someone_elses', note: 'dinner' });

		expect(result.isError).toBe(true);
		expect(envelopeOf(result).code).toBe('not_found');
		expect(createCapture).not.toHaveBeenCalled();
	});
});
