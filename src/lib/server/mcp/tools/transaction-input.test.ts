import { describe, expect, it } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { MemberListItem } from '$lib/server/members';
import { toMemberView } from '../view';
import {
	McpTransactionArgumentError,
	mcpTransactionArguments,
	toTransactionInput,
	type McpTransactionContext
} from './transaction-input';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	name: 'test key',
	userId: 'user_a',
	permissions: null
};

/**
 * A roster whose names exercise the normalization rule the uniqueness index uses:
 * `Ann` is padded and mixed-case in the arguments below, `Céline` is composed, and
 * `Gone` is DEACTIVATED — a name that exists but may not take part in a new write.
 */
const ROSTER: MemberListItem[] = [
	{ id: 'mem_a', displayName: 'Ann', userId: 'user_a', deactivatedAt: null, isLinked: true },
	{ id: 'mem_b', displayName: 'Bob', userId: 'user_b', deactivatedAt: null, isLinked: true },
	{ id: 'mem_c', displayName: 'Céline', userId: 'user_c', deactivatedAt: null, isLinked: true },
	{
		id: 'mem_gone',
		displayName: 'Gone',
		userId: null,
		deactivatedAt: '2026-06-01T00:00:00.000Z',
		isLinked: false
	}
];

const members = ROSTER.map((m) => toMemberView(m, principal));

const context: McpTransactionContext = {
	type: 'spending',
	title: 'Dinner',
	date: '2026-07-20',
	categoryId: 'spending-other',
	currency: 'THB',
	payer: { kind: 'name', memberName: 'Ann' },
	members
};

/** Run the adapter expecting it to reject, and return the collected issues. */
function issuesFor(args: unknown, overriddenContext: McpTransactionContext = context) {
	try {
		toTransactionInput(args, overriddenContext);
		throw new Error('Expected adapter validation to fail.');
	} catch (error) {
		expect(error).toBeInstanceOf(McpTransactionArgumentError);
		return (error as McpTransactionArgumentError).issues;
	}
}

describe('MCP transaction argument contract', () => {
	it('preserves the legacy equal-split shape', () => {
		const input = toTransactionInput({ amount: '240.00', splitBetween: ['Ann', 'Bob'] }, context);

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
					{ memberName: 'Ann', amount: '4.25' },
					{ memberName: 'Bob', amount: '5.75' }
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
					{ memberName: 'Ann', shareWeight: 0 },
					{ memberName: 'Bob', shareWeight: 3 }
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
					{ memberName: 'Ann', shareWeight: 0 },
					{ memberName: 'Bob', shareWeight: 0 }
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
							{ memberName: 'Ann', amount: '60.00' },
							{ memberName: 'Bob', amount: '40.00' }
						]
					},
					{
						label: 'Drinks',
						amount: '50.00',
						splitMode: 'share',
						beneficiaries: [
							{ memberName: 'Ann', shareWeight: 1 },
							{ memberName: 'Céline', shareWeight: 2 }
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
		// Every nested item beneficiary resolved to its own member, in order.
		expect(input.items.map((item) => item.beneficiaries.map((row) => row.memberId))).toEqual([
			['mem_a', 'mem_b'],
			['mem_a', 'mem_c']
		]);
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
					beneficiaries: [{ memberName: 'Ann' }]
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
		expect(() => toTransactionInput({ amount: '1.001', splitBetween: ['Ann'] }, context)).toThrow(
			McpTransactionArgumentError
		);

		try {
			toTransactionInput({ amount: '1.001', splitBetween: ['Ann'] }, context);
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
						beneficiaries: [{ memberName: 'Ann' }]
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

	// ── NAME RESOLUTION (ADR-0015) ────────────────────────────────────────────

	describe('resolving member names', () => {
		it('matches a name the way the uniqueness index does: normalized, exact, whole-string', () => {
			// Padding and case fold away (`normalizeDisplayName`: NFC → trim → lowercase),
			// and a DECOMPOSED `Céline` matches the composed roster entry.
			const input = toTransactionInput(
				{ amount: '3.00', splitBetween: ['  aNN  ', 'BOB', 'Céline'] },
				context
			);

			expect(input.beneficiaries).toEqual([
				{ memberId: 'mem_a' },
				{ memberId: 'mem_b' },
				{ memberId: 'mem_c' }
			]);
		});

		it('never matches a PREFIX — that is `similar-names.ts`’s job, not the money path’s', () => {
			// `Ann` is a real member; `An` is nobody, and a resolver that guessed would be
			// making exactly the wrong-but-valid pick ADR-0015 refuses to make server-side.
			const issues = issuesFor({ amount: '1.00', splitBetween: ['An'] });

			expect(issues[0].path).toEqual(['splitBetween', 0]);
			expect(issues[0].message).toMatch(/No active member of this group is named "An"/);
		});

		it('rejects a member ID passed where a name belongs — it is no longer accepted at all', () => {
			// The pre-ADR-0015 wire. It matches no display name, so it is an ordinary,
			// self-correctable validation issue rather than a silently accepted reference.
			const issues = issuesFor({ amount: '1.00', splitBetween: ['mem_b'] });

			expect(issues).toHaveLength(1);
			expect(issues[0].path).toEqual(['splitBetween', 0]);
			expect(issues[0].message).toMatch(/mem_b/);
			expect(issues[0].message).toMatch(/list_members/);
		});

		it('names a DEACTIVATED member as removed, not as a name nobody has', () => {
			const issues = issuesFor({
				splitMode: 'share',
				amount: '1.00',
				beneficiaries: [{ memberName: 'Gone', shareWeight: 1 }]
			});

			expect(issues[0].path).toEqual(['beneficiaries', 0, 'memberName']);
			expect(issues[0].message).toMatch(/removed from this group/);
		});

		it('reports EVERY unresolvable name at once, at its exact MCP argument path', () => {
			// Batched deliberately: one round trip must tell the agent about all of them, or
			// a four-name typo costs four corrections.
			const issues = issuesFor(
				{ amount: '1.00', splitBetween: ['Ann', 'Nobody', 'Gone'] },
				{ ...context, payer: { kind: 'name', memberName: 'Ghost' } }
			);

			expect(issues.map((issue) => issue.path)).toEqual([
				['paidBy'],
				['splitBetween', 1],
				['splitBetween', 2]
			]);
		});

		it('reports an unresolvable itemized beneficiary at its nested path', () => {
			expect(
				issuesFor({
					splitMode: 'itemized',
					items: [
						{
							label: 'Food',
							amount: '1.00',
							splitMode: 'equal',
							beneficiaries: [{ memberName: 'Nobody' }]
						}
					]
				})[0].path
			).toEqual(['items', 0, 'beneficiaries', 0, 'memberName']);
		});

		it('reports a DEFAULTED payer who is no longer active under `paidBy`', () => {
			// The tools default `paidBy` to an id they already hold (the caller on a create,
			// the recorded payer on an update) — which the group may since have removed.
			const issues = issuesFor(
				{ amount: '1.00', splitBetween: ['Ann'] },
				{ ...context, payer: { kind: 'default', memberId: 'mem_gone' } }
			);

			expect(issues[0].path).toEqual(['paidBy']);
			expect(issues[0].message).toMatch(/Pass an explicit `paidBy` name/);
		});

		it('accepts a DEFAULTED payer that is an active member, without matching any name', () => {
			const input = toTransactionInput(
				{ amount: '1.00', splitBetween: ['Ann'] },
				{ ...context, payer: { kind: 'default', memberId: 'mem_b' } }
			);

			expect(input.payers).toEqual([{ memberId: 'mem_b', amountPaid: 100 }]);
		});
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

		const zero = capture({ amount: '0.00', splitBetween: ['Ann'] });
		expect(zero.issues.map((issue) => issue.path)).toContainEqual(['amount']);
		expect(zero.issues.flatMap((issue) => issue.path)).not.toContain('amountTotal');

		const negativeDerived = capture({
			splitMode: 'itemized',
			items: [
				{
					label: 'Food',
					amount: '10.00',
					splitMode: 'equal',
					beneficiaries: [{ memberName: 'Ann' }]
				}
			],
			charges: [{ kind: 'discount', mode: 'absolute', amount: '10.01', base: 'running_total' }]
		});
		expect(negativeDerived.issues.map((issue) => issue.path)).toContainEqual(['charges']);
		expect(negativeDerived.issues.flatMap((issue) => issue.path)).not.toContain('amountTotal');
	});
});
