import { describe, expect, it } from 'vitest';
import {
	McpTransactionArgumentError,
	mcpTransactionArguments,
	toTransactionInput
} from './transaction-input';

const context = {
	type: 'spending' as const,
	title: 'Dinner',
	date: '2026-07-20',
	categoryId: 'spending-other',
	currency: 'THB' as const,
	payerId: 'mem_a',
	memberIds: ['mem_a', 'mem_b', 'mem_c']
};

describe('MCP transaction argument contract', () => {
	it('preserves the legacy equal-split shape', () => {
		const input = toTransactionInput(
			{ amount: '240.00', splitBetween: ['mem_a', 'mem_b'] },
			context
		);

		expect(input).toMatchObject({
			amountTotal: 24_000,
			amountTotalSettlement: 24_000,
			exchangeRate: '1',
			splitMode: 'equal',
			payers: [{ memberId: 'mem_a', amountPaid: 24_000 }],
			beneficiaries: [{ memberId: 'mem_a' }, { memberId: 'mem_b' }],
			items: [],
			charges: []
		});
	});

	it('maps decimal beneficiary amounts to internal rawAmount', () => {
		const input = toTransactionInput(
			{
				splitMode: 'amount',
				amount: '10.00',
				beneficiaries: [
					{ memberId: 'mem_a', amount: '4.25' },
					{ memberId: 'mem_b', amount: '5.75' }
				]
			},
			context
		);

		expect(input.beneficiaries).toEqual([
			{ memberId: 'mem_a', rawAmount: 425 },
			{ memberId: 'mem_b', rawAmount: 575 }
		]);
	});

	it('keeps share weights as non-negative safe integers with a positive sum', () => {
		const input = toTransactionInput(
			{
				splitMode: 'share',
				amount: '10.00',
				beneficiaries: [
					{ memberId: 'mem_a', shareWeight: 0 },
					{ memberId: 'mem_b', shareWeight: 3 }
				]
			},
			context
		);
		expect(input.beneficiaries).toEqual([
			{ memberId: 'mem_a', shareWeight: 0 },
			{ memberId: 'mem_b', shareWeight: 3 }
		]);

		expect(
			mcpTransactionArguments.safeParse({
				splitMode: 'share',
				amount: '10.00',
				beneficiaries: [
					{ memberId: 'mem_a', shareWeight: 0 },
					{ memberId: 'mem_b', shareWeight: 0 }
				]
			}).success
		).toBe(false);
	});

	it('derives an itemized total and sortOrder from ordered human charge variants', () => {
		const input = toTransactionInput(
			{
				splitMode: 'itemized',
				items: [
					{
						label: 'Food',
						amount: '100.00',
						splitMode: 'amount',
						beneficiaries: [
							{ memberId: 'mem_a', amount: '60.00' },
							{ memberId: 'mem_b', amount: '40.00' }
						]
					},
					{
						label: 'Drinks',
						amount: '50.00',
						splitMode: 'share',
						beneficiaries: [
							{ memberId: 'mem_a', shareWeight: 1 },
							{ memberId: 'mem_c', shareWeight: 2 }
						]
					}
				],
				charges: [
					{ kind: 'service', mode: 'percent', percent: '10', base: 'items_subtotal' },
					{ kind: 'discount', mode: 'absolute', amount: '5.00', base: 'running_total' }
				]
			},
			context
		);

		expect(input.amountTotal).toBe(16_000);
		expect(input.payers).toEqual([{ memberId: 'mem_a', amountPaid: 16_000 }]);
		expect(input.charges).toEqual([
			{
				kind: 'service',
				mode: 'percent',
				value: 1000,
				base: 'items_subtotal',
				sortOrder: 0
			},
			{
				kind: 'discount',
				mode: 'absolute',
				value: 500,
				base: 'running_total',
				sortOrder: 1
			}
		]);
	});

	it('accepts 100% and exact fractional percentages, but returns validation for over 100%', () => {
		const itemized = (percent: string) => ({
			splitMode: 'itemized' as const,
			items: [
				{
					label: 'Food',
					amount: '10.00',
					splitMode: 'equal' as const,
					beneficiaries: [{ memberId: 'mem_a' }]
				}
			],
			charges: [
				{ kind: 'vat' as const, mode: 'percent' as const, percent, base: 'items_subtotal' as const }
			]
		});

		expect(mcpTransactionArguments.safeParse(itemized('100')).success).toBe(true);
		expect(toTransactionInput(itemized('7.25'), context).charges[0].value).toBe(725);
		for (const invalid of ['100.01', '101']) {
			expect(() => mcpTransactionArguments.safeParse(itemized(invalid))).not.toThrow();
			const result = mcpTransactionArguments.safeParse(itemized(invalid));
			expect(result.success).toBe(false);
			if (!result.success) expect(result.error.issues[0].path).toEqual(['charges', 0, 'percent']);
		}
	});

	it('rejects currency overprecision at the MCP field path', () => {
		expect(() => toTransactionInput({ amount: '1.001', splitBetween: ['mem_a'] }, context)).toThrow(
			McpTransactionArgumentError
		);

		try {
			toTransactionInput({ amount: '1.001', splitBetween: ['mem_a'] }, context);
		} catch (error) {
			expect((error as McpTransactionArgumentError).issues[0].path).toEqual(['amount']);
			expect((error as Error).message).toMatch(/decimal places/i);
		}
	});

	it('rejects ambiguous charge shapes and client-supplied itemized totals', () => {
		expect(
			mcpTransactionArguments.safeParse({
				splitMode: 'itemized',
				amount: '11.00',
				items: [
					{
						label: 'Food',
						amount: '10.00',
						splitMode: 'equal',
						beneficiaries: [{ memberId: 'mem_a' }]
					}
				],
				charges: [
					{
						kind: 'vat',
						mode: 'percent',
						percent: '7',
						amount: '1.00',
						base: 'items_subtotal'
					}
				]
			}).success
		).toBe(false);
	});

	it('reports membership failures only in MCP wire vocabulary', () => {
		const issuesFor = (args: unknown, overriddenContext = context) => {
			try {
				toTransactionInput(args, overriddenContext);
				throw new Error('Expected adapter validation to fail.');
			} catch (error) {
				expect(error).toBeInstanceOf(McpTransactionArgumentError);
				return (error as McpTransactionArgumentError).issues;
			}
		};

		expect(
			issuesFor(
				{ amount: '1.00', splitBetween: ['mem_a'] },
				{ ...context, payerId: 'mem_unknown' }
			)[0].path
		).toEqual(['paidBy']);
		expect(issuesFor({ amount: '1.00', splitBetween: ['mem_unknown'] })[0].path).toEqual([
			'splitBetween',
			0
		]);
		expect(
			issuesFor({
				splitMode: 'share',
				amount: '1.00',
				beneficiaries: [{ memberId: 'mem_unknown', shareWeight: 1 }]
			})[0].path
		).toEqual(['beneficiaries', 0, 'memberId']);
		expect(
			issuesFor({
				splitMode: 'itemized',
				items: [
					{
						label: 'Food',
						amount: '1.00',
						splitMode: 'equal',
						beneficiaries: [{ memberId: 'mem_unknown' }]
					}
				]
			})[0].path
		).toEqual(['items', 0, 'beneficiaries', 0, 'memberId']);
	});

	it('remaps invalid direct and server-derived totals to MCP amount/charge paths', () => {
		const capture = (args: unknown): McpTransactionArgumentError => {
			try {
				toTransactionInput(args, context);
				throw new Error('Expected adapter validation to fail.');
			} catch (error) {
				expect(error).toBeInstanceOf(McpTransactionArgumentError);
				return error as McpTransactionArgumentError;
			}
		};

		const zero = capture({ amount: '0.00', splitBetween: ['mem_a'] });
		expect(zero.issues.map((issue) => issue.path)).toContainEqual(['amount']);
		expect(zero.issues.flatMap((issue) => issue.path)).not.toContain('amountTotal');

		const negativeDerived = capture({
			splitMode: 'itemized',
			items: [
				{
					label: 'Food',
					amount: '10.00',
					splitMode: 'equal',
					beneficiaries: [{ memberId: 'mem_a' }]
				}
			],
			charges: [{ kind: 'discount', mode: 'absolute', amount: '10.01', base: 'running_total' }]
		});
		expect(negativeDerived.issues.map((issue) => issue.path)).toContainEqual(['charges']);
		expect(negativeDerived.issues.flatMap((issue) => issue.path)).not.toContain('amountTotal');
	});
});
