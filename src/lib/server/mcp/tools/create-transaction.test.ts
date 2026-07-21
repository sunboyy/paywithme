import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { TransactionDetail } from '$lib/server/transactions';

const {
	loadGroupView,
	loadMemberViews,
	createTransaction,
	getTransactionDetail,
	withDerivedIdempotency
} = vi.hoisted(() => ({
	loadGroupView: vi.fn(),
	loadMemberViews: vi.fn(),
	createTransaction: vi.fn(),
	getTransactionDetail: vi.fn(),
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
});

describe('create_transaction rich wiring', () => {
	it('keeps the legacy equal call and its existing MCP field names', async () => {
		const result = await run({
			groupId: GROUP_ID,
			title: 'Lunch',
			amount: '240.00',
			splitBetween: ['mem_me', 'mem_bob']
		});
		expect(result.isError).toBeUndefined();
		expect(inputPassed()).toMatchObject({
			amountTotal: 24_000,
			splitMode: 'equal',
			payers: [{ memberId: 'mem_me', amountPaid: 24_000 }],
			beneficiaries: [{ memberId: 'mem_me' }, { memberId: 'mem_bob' }]
		});
	});

	it.each([
		[
			'amount',
			[
				{ memberId: 'mem_me', amount: '4.25' },
				{ memberId: 'mem_bob', amount: '5.75' }
			],
			[
				{ memberId: 'mem_me', rawAmount: 425 },
				{ memberId: 'mem_bob', rawAmount: 575 }
			]
		],
		[
			'share',
			[
				{ memberId: 'mem_me', shareWeight: 1 },
				{ memberId: 'mem_bob', shareWeight: 3 }
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
			paidBy: 'mem_bob',
			items: [
				{
					label: 'Food',
					amount: '100.00',
					splitMode: 'amount',
					beneficiaries: [
						{ memberId: 'mem_me', amount: '40.00' },
						{ memberId: 'mem_bob', amount: '60.00' }
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
					beneficiaries: [{ memberId: 'mem_inactive' }]
				}
			]
		});
		expect(result.isError).toBe(true);
		const envelope = result.structuredContent as unknown as {
			error: { code: string; details: { fieldErrors: Record<string, string[]> } };
		};
		expect(envelope.error.code).toBe('validation_error');
		expect(envelope.error.details.fieldErrors).toHaveProperty('items.0.beneficiaries.0.memberId');
		expect(withDerivedIdempotency).not.toHaveBeenCalled();
		expect(createTransaction).not.toHaveBeenCalled();
	});
});
