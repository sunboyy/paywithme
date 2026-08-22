import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { TransactionDetail } from '$lib/server/transactions';

const {
	loadGroupView,
	loadMemberViews,
	createTransaction,
	getTransactionDetail,
	peekIdempotentReplay,
	withDerivedIdempotency
} = vi.hoisted(() => ({
	loadGroupView: vi.fn(),
	loadMemberViews: vi.fn(),
	createTransaction: vi.fn(),
	getTransactionDetail: vi.fn(),
	peekIdempotentReplay: vi.fn(),
	withDerivedIdempotency: vi.fn()
}));

vi.mock('./load', () => ({ loadGroupView, loadMemberViews }));
vi.mock('$lib/server/transactions', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/transactions')>()),
	createTransaction,
	getTransactionDetail
}));
vi.mock('../idempotency', async (importOriginal) => ({
	...(await importOriginal<typeof import('../idempotency')>()),
	peekIdempotentReplay,
	withDerivedIdempotency
}));
vi.mock('$lib/server/api/idempotency', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/api/idempotency')>()),
	createDbIdempotencyStore: () => ({}) as never
}));

import { createTransactionTool } from './create-transaction';

const principal: ApiKeyPrincipal = {
	keyId: 'key_create',
	name: 'write key',
	userId: 'user_me',
	permissions: null
};
const GROUP_ID = 'grp_1';
const members = [
	{
		id: 'mem_me',
		displayName: { _untrusted: true as const, value: 'Alice', author: { kind: 'you' as const } },
		isYou: true,
		isLinked: true,
		isActive: true
	},
	{
		id: 'mem_bob',
		displayName: { _untrusted: true as const, value: 'Bob', author: { kind: 'unknown' as const } },
		isYou: false,
		isLinked: true,
		isActive: true
	},
	{
		id: 'mem_inactive',
		displayName: { _untrusted: true as const, value: 'Gone', author: { kind: 'unknown' as const } },
		isYou: false,
		isLinked: false,
		isActive: false
	}
];

function inputPassed() {
	return createTransaction.mock.calls[0][0].input;
}

function persistedDetail(): TransactionDetail {
	const input = inputPassed();
	const itemMemberIds = input.items.flatMap((item: { beneficiaries: { memberId: string }[] }) =>
		item.beneficiaries.map((row) => row.memberId)
	);
	const beneficiaryIds =
		input.splitMode === 'itemized'
			? [...new Set(itemMemberIds)]
			: input.beneficiaries.map((row: { memberId: string }) => row.memberId);
	return {
		id: 'txn_1',
		groupId: GROUP_ID,
		type: 'spending',
		title: input.title,
		categoryId: input.categoryId,
		categoryName: 'Other',
		categoryIcon: 'shapes',
		createdBy: principal.userId,
		amountTotal: input.amountTotal,
		currency: input.currency,
		amountTotalSettlement: input.amountTotalSettlement,
		settlementCurrency: 'THB',
		isForeign: false,
		splitMode: input.splitMode,
		createdAt: `${input.date}T12:00:00.000Z`,
		deletedAt: null,
		payers: input.payers,
		shares: beneficiaryIds.map((memberId: string) => ({ memberId, amountOwed: 0 })),
		items: input.items.map(
			(item: {
				label: string;
				amount: number;
				splitMode: 'equal' | 'amount' | 'share';
				beneficiaries: { memberId: string }[];
			}) => ({
				label: item.label,
				amount: item.amount,
				splitMode: item.splitMode,
				shares: item.beneficiaries.map((row) => ({ memberId: row.memberId, amountOwed: 0 }))
			})
		),
		charges: input.charges,
		input
	};
}

async function run(args: Record<string, unknown>) {
	const parsed = createTransactionTool.args.parse(args);
	return createTransactionTool.run({ principal }, parsed);
}

beforeEach(() => {
	vi.clearAllMocks();
	loadGroupView.mockResolvedValue({ settlementCurrency: 'THB' });
	loadMemberViews.mockResolvedValue(members);
	createTransaction.mockResolvedValue('txn_1');
	getTransactionDetail.mockImplementation(async () => persistedDetail());
	withDerivedIdempotency.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => ({
		response: await fn(),
		replayedAfterMs: null
	}));
	// Its own suite lives in `../idempotency.test.ts`; by default there is no earlier
	// completed match, so the ordinary path (validate, then the guard above) runs.
	peekIdempotentReplay.mockResolvedValue(null);
});

describe('create_transaction rich wiring', () => {
	it('keeps the legacy equal call, now naming members by DISPLAY NAME (ADR-0015)', async () => {
		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['Alice', 'Bob']
		});
		expect(result.isError).toBeUndefined();
		expect(inputPassed()).toMatchObject({
			amountTotal: 24_000,
			splitMode: 'equal',
			// Names in, ids out: the service layer below is untouched by ADR-0015.
			payers: [{ memberId: 'mem_me', amountPaid: 24_000 }],
			beneficiaries: [{ memberId: 'mem_me' }, { memberId: 'mem_bob' }]
		});
	});

	it.each([
		[
			'amount',
			[
				{ memberName: 'Alice', amount: '4.25' },
				{ memberName: 'Bob', amount: '5.75' }
			],
			[
				{ memberId: 'mem_me', rawAmount: 425 },
				{ memberId: 'mem_bob', rawAmount: 575 }
			]
		],
		[
			'share',
			[
				{ memberName: 'Alice', shareWeight: 1 },
				{ memberName: 'Bob', shareWeight: 3 }
			],
			[
				{ memberId: 'mem_me', shareWeight: 1 },
				{ memberId: 'mem_bob', shareWeight: 3 }
			]
		]
	] as const)(
		'maps a top-level %s split through the shared adapter',
		async (splitMode, rows, expected) => {
			const result = await run({
				groupId: GROUP_ID,
				title: 'Dinner',
				splitMode,
				amount: '10.00',
				beneficiaries: rows
			});
			expect(result.isError).toBeUndefined();
			expect(inputPassed().splitMode).toBe(splitMode);
			expect(inputPassed().beneficiaries).toEqual(expected);
			const payload = result.structuredContent as { echo: string };
			expect(payload.echo).not.toContain('split equally');
		}
	);

	it('derives itemized total/payer and charge order, fingerprints every raw argument, and audits via key', async () => {
		const args = {
			groupId: GROUP_ID,
			title: 'Receipt',
			splitMode: 'itemized',
			paidBy: 'Bob',
			items: [
				{
					label: 'Food',
					amount: '100.00',
					splitMode: 'amount',
					beneficiaries: [
						{ memberName: 'Alice', amount: '40.00' },
						{ memberName: 'Bob', amount: '60.00' }
					]
				}
			],
			charges: [
				{ kind: 'vat', mode: 'percent', percent: '7.25', base: 'items_subtotal' },
				{ kind: 'discount', mode: 'absolute', amount: '2.25', base: 'running_total' }
			]
		};
		const result = await run(args);
		expect(result.isError).toBeUndefined();
		expect(inputPassed()).toMatchObject({
			amountTotal: 10_500,
			amountTotalSettlement: 10_500,
			payers: [{ memberId: 'mem_bob', amountPaid: 10_500 }],
			charges: [
				{ mode: 'percent', value: 725, sortOrder: 0 },
				{ mode: 'absolute', value: 225, sortOrder: 1 }
			]
		});
		expect(createTransaction.mock.calls[0][0].via).toEqual({
			kind: 'key',
			keyId: principal.keyId,
			keyName: principal.name
		});
		expect(withDerivedIdempotency.mock.calls[0][0].args).toEqual(
			createTransactionTool.args.parse(args)
		);
		const payload = result.structuredContent as { echo: string };
		expect(payload.echo).toContain('split by 1 item');
	});

	it('passes the FULL roster snapshot for `createTransaction` to re-verify (PR #80 review)', async () => {
		// Unlike `settle_up`, this tool cannot cheaply tell which ids came from a NAME
		// (`paidBy`, `splitBetween`) vs. a DEFAULT (the caller's own member) without
		// reaching into the shared adapter — so it hands over every member it saw, and
		// `transactions.ts` only checks the ones the resolved input actually references.
		await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '12.00',
			splitBetween: ['Alice']
		});
		expect(createTransaction.mock.calls[0][0].expectedMemberNames).toEqual(
			new Map([
				['mem_me', 'Alice'],
				['mem_bob', 'Bob'],
				['mem_inactive', 'Gone']
			])
		);
	});

	it('a PEEKED replay short-circuits before the roster loads or any name resolves (PR #80 review)', async () => {
		// The exact bug this guards against: `paidBy` names nobody on the CURRENT
		// roster (it would fail validation if reached) — but this call is a plain
		// retry of one that already succeeded when the roster was different (the
		// member since renamed or deactivated). The peek must return the stored
		// success WITHOUT ever loading members or attempting to resolve that name.
		peekIdempotentReplay.mockResolvedValue({
			response: {
				status: 200,
				body: { recorded: { id: 'txn_1' }, echo: 'Recorded: stub', _note: 'stub' }
			},
			replayedAfterMs: 4200
		});

		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['Alice'],
			paidBy: 'Nobody On The Roster Anymore'
		});

		expect(result.isError).toBeUndefined();
		const payload = result.structuredContent as {
			replayed: boolean;
			recordedAgoSeconds: number;
			echo: string;
		};
		expect(payload.replayed).toBe(true);
		expect(payload.recordedAgoSeconds).toBe(4);
		expect(payload.echo).toContain('already recorded');
		// The whole point: neither the roster nor the write path was ever touched.
		expect(loadMemberViews).not.toHaveBeenCalled();
		expect(createTransaction).not.toHaveBeenCalled();
		expect(withDerivedIdempotency).not.toHaveBeenCalled();
	});

	it('a peek MISS still validates and reaches the write guard normally', async () => {
		// The default `beforeEach` mock already resolves `peekIdempotentReplay` to
		// `null`; this asserts the ordinary path is unaffected by its presence.
		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['Alice']
		});

		expect(result.isError).toBeUndefined();
		expect(loadMemberViews).toHaveBeenCalled();
		expect(withDerivedIdempotency).toHaveBeenCalled();
	});

	it('returns nested inactive members as self-correctable MCP validation paths before idempotency', async () => {
		const result = await run({
			groupId: GROUP_ID,
			title: 'Receipt',
			splitMode: 'itemized',
			items: [
				{
					label: 'Food',
					amount: '10.00',
					splitMode: 'equal',
					// "Gone" is a real name on the roster — of a DEACTIVATED member.
					beneficiaries: [{ memberName: 'Gone' }]
				}
			]
		});
		expect(result.isError).toBe(true);
		const envelope = result.structuredContent as unknown as {
			error: { code: string; details: { fieldErrors: Record<string, string[]> } };
		};
		expect(envelope.error.code).toBe('validation_error');
		expect(envelope.error.details.fieldErrors['items.0.beneficiaries.0.memberName'][0]).toMatch(
			/removed from this group/
		);
		expect(withDerivedIdempotency).not.toHaveBeenCalled();
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('refuses a member ID where a member NAME belongs — no dual-accept (ADR-0015)', async () => {
		// The pre-ADR-0015 wire, sent by an agent that learned the old contract. It must be
		// an ordinary, self-correctable validation_error — never silently accepted.
		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['mem_me', 'mem_bob']
		});

		expect(result.isError).toBe(true);
		const envelope = result.structuredContent as unknown as {
			error: { code: string; details: { fieldErrors: Record<string, string[]> } };
		};
		expect(envelope.error.code).toBe('validation_error');
		// BOTH names are reported at once, each at its own index, and at the root field.
		expect(Object.keys(envelope.error.details.fieldErrors).sort()).toEqual([
			'splitBetween',
			'splitBetween.0',
			'splitBetween.1'
		]);
		expect(envelope.error.details.fieldErrors['splitBetween.0'][0]).toMatch(/list_members/);
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('a name matching NO member is a self-correctable validation_error naming what was searched', async () => {
		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['Alice', 'Carol']
		});

		expect(result.isError).toBe(true);
		const envelope = result.structuredContent as unknown as {
			error: { code: string; message: string; details: { fieldErrors: Record<string, string[]> } };
		};
		expect(envelope.error.code).toBe('validation_error');
		expect(envelope.error.details.fieldErrors['splitBetween.1'][0]).toBe(
			'No active member of this group is named "Carol". Call `list_members` and pass a ' +
				'display name exactly as it appears there — member names, not member ids.'
		);
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('matches a name the way the uniqueness index does — normalized, and never by prefix', async () => {
		await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['  aLiCe ', 'Bob']
		});
		expect(inputPassed().beneficiaries).toEqual([{ memberId: 'mem_me' }, { memberId: 'mem_bob' }]);

		vi.clearAllMocks();
		loadGroupView.mockResolvedValue({ settlementCurrency: 'THB' });
		loadMemberViews.mockResolvedValue(members);

		// `Ali` is a prefix of `Alice` and matches nobody: the money path never guesses.
		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['Ali']
		});
		expect(result.isError).toBe(true);
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('resolves an explicit `paidBy` NAME, and defaults to you when it is omitted', async () => {
		await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			paidBy: 'Bob',
			splitBetween: ['Alice', 'Bob']
		});
		expect(inputPassed().payers).toEqual([{ memberId: 'mem_bob', amountPaid: 24_000 }]);
	});

	it('reports an unresolvable `paidBy` under `paidBy`, not under the split', async () => {
		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			paidBy: 'Gone',
			splitBetween: ['Alice', 'Bob']
		});

		expect(result.isError).toBe(true);
		const envelope = result.structuredContent as unknown as {
			error: { code: string; details: { fieldErrors: Record<string, string[]> } };
		};
		expect(envelope.error.code).toBe('validation_error');
		expect(envelope.error.details.fieldErrors.paidBy[0]).toMatch(/removed from this group/);
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('refuses a CUSTOM currency code with the existing error (ADR-0014 decision 7)', async () => {
		// Regression for issue #64: the READ surfaces learned to serve `display_code`, so
		// a model can now SEE `BEER` in a `get_transaction` result. The write path must
		// have learned nothing — a custom code is still simply "not the group settlement
		// currency", refused before anything is written.
		const result = await run({
			groupId: GROUP_ID,
			title: 'Round',
			amount: '3',
			currency: 'BEER',
			splitBetween: ['Alice', 'Bob']
		});

		expect(result.isError).toBe(true);
		const envelope = result.structuredContent as unknown as {
			error: { code: string; message: string; details: { fieldErrors: Record<string, string[]> } };
		};
		expect(envelope.error.code).toBe('validation_error');
		expect(envelope.error.message).toContain('THB');
		expect(envelope.error.details.fieldErrors.currency).toEqual([
			'Currency must be THB for this group.'
		]);
		expect(createTransaction).not.toHaveBeenCalled();
	});
});
