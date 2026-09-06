import { describe, expect, it, vi, beforeEach } from 'vitest';

// Unit spec for the payer-facing view of a member's receiving details (issue #86;
// PLAN §17.3–§17.4).
//
// Two things are checked here, because both are load-bearing and neither is
// visible from a component test:
//
//   1. THE ONLY READ PATH IS `listForViewer`. It is mocked below, so any future
//      shortcut straight to the table would make these tests fail to see the data
//      at all. Visibility itself (shared co-membership, deactivation, deleted
//      groups) belongs to `receiving-methods.test.ts` and is not re-tested here.
//   2. THE EMPTY-STATE DECISION comes from the MEMBER, not from the list — an
//      unlinked slot is `unlinked` without a read, and a viewer who shares no
//      group with the target reads [] and lands on the same `no-methods` answer as
//      a co-member with nothing recorded, so the two stay indistinguishable.
//
// The rail registry is REAL here: rendering a stored row is exactly what this
// module does, and mocking the rails would leave the interesting part untested.

const { listForViewer } = vi.hoisted(() => ({ listForViewer: vi.fn() }));

vi.mock('./receiving-methods', () => ({ listForViewer }));

import { loadReceivingProfiles, toMethodView, toProfileView } from './receiving-view';

/** A stored row, shaped like the table's `$inferSelect`. */
function row(overrides: Record<string, unknown> = {}) {
	return {
		id: 'rm1',
		userId: 'u2',
		rail: 'th_bank_account',
		details: {
			bank: 'kbank',
			accountNumber: '1234567890',
			accountHolderName: 'Somchai Jaidee'
		},
		position: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides
	} as Parameters<typeof toMethodView>[0];
}

const PROMPTPAY = row({
	id: 'rm2',
	rail: 'th_promptpay',
	details: { proxyType: 'mobile', proxyValue: '0812345678', accountHolderName: 'Somchai Jaidee' },
	position: 1
});

beforeEach(() => {
	listForViewer.mockReset();
	listForViewer.mockResolvedValue([]);
});

describe('toMethodView', () => {
	it('renders every field the rail declares, in the rail’s own order', () => {
		const view = toMethodView(row());

		expect(view.railLabel).toBe('Thai bank account');
		expect(view.fields?.map((f) => f.label)).toEqual([
			'Bank',
			'Account number',
			'Account holder name'
		]);
	});

	it('resolves a select to the label the picker showed, not the stored code', () => {
		// The payer needs "Kasikornbank (KBank)"; `kbank` means nothing to them.
		const bank = toMethodView(row()).fields?.[0];

		expect(bank?.value).toBe('Kasikornbank (KBank)');
	});

	it('marks exactly one value to copy and one name to check', () => {
		// The two payer affordances (PLAN §17.2): the number goes on the clipboard,
		// the holder name is what the instruction tells them to compare.
		for (const method of [row(), PROMPTPAY]) {
			const view = toMethodView(method);
			const roles = view.fields?.map((f) => f.payerRole);

			expect(
				roles?.filter((r) => r === 'copy'),
				method.rail
			).toHaveLength(1);
			expect(
				roles?.filter((r) => r === 'name-check'),
				method.rail
			).toHaveLength(1);
			// The copy target is the number, never the name.
			expect(view.fields?.find((f) => f.payerRole === 'copy')?.value, method.rail).toMatch(/^\d+$/);
		}
	});

	it('refuses to half-render details the rail no longer accepts', () => {
		// A schema change (or a hand-edited row) must not put half an account number
		// in front of someone who is about to make a transfer.
		const view = toMethodView(row({ details: { bank: 'kbank', accountNumber: '12' } }));

		expect(view.fields).toBeNull();
		expect(view.railLabel).toBe('Thai bank account');
	});

	it('refuses to render a rail the registry does not know', () => {
		const view = toMethodView(row({ rail: 'sepa', details: { iban: 'DE89' } }));

		expect(view.fields).toBeNull();
		// No label to give, so the key itself — never an empty heading.
		expect(view.railLabel).toBe('sepa');
	});
});

describe('toProfileView', () => {
	it('reports an empty profile as `no-methods`, never as an empty method list', () => {
		expect(toProfileView([])).toEqual({ state: 'no-methods' });
	});

	it('keeps the stored order — the first is the preferred one (PLAN §17.1)', () => {
		const view = toProfileView([row(), PROMPTPAY]);

		expect(view.state).toBe('methods');
		expect(view.state === 'methods' && view.methods.map((m) => m.id)).toEqual(['rm1', 'rm2']);
	});
});

describe('loadReceivingProfiles', () => {
	it('answers `unlinked` for a participant slot WITHOUT reading anything', async () => {
		// An unlinked member has no user to ask about (PLAN §17.1) — the answer is an
		// invite, not data entry, so there is nothing to query.
		const profiles = await loadReceivingProfiles('u1', [{ id: 'm2', userId: null }]);

		expect(profiles.m2).toEqual({ state: 'unlinked' });
		expect(listForViewer).not.toHaveBeenCalled();
	});

	it('reads each linked member through `listForViewer`, keyed by MEMBER id', async () => {
		listForViewer.mockResolvedValue([row(), PROMPTPAY]);

		const profiles = await loadReceivingProfiles('u1', [{ id: 'm3', userId: 'u2' }]);

		expect(listForViewer).toHaveBeenCalledWith('u1', 'u2');
		expect(profiles.m3.state).toBe('methods');
	});

	it('shows nothing to a viewer who shares no group with the creditor', async () => {
		// `listForViewer` answers [] for a stranger — and for a co-member with nothing
		// recorded. Both land here, so a viewer cannot tell the two apart.
		listForViewer.mockResolvedValue([]);

		const profiles = await loadReceivingProfiles('stranger', [{ id: 'm3', userId: 'u2' }]);

		expect(profiles.m3).toEqual({ state: 'no-methods' });
		expect(JSON.stringify(profiles)).not.toContain('1234567890');
	});

	it('reads each linked user once, however many members point at them', async () => {
		await loadReceivingProfiles('u1', [
			{ id: 'm1', userId: 'u2' },
			{ id: 'm2', userId: 'u2' },
			{ id: 'm3', userId: null }
		]);

		expect(listForViewer).toHaveBeenCalledTimes(1);
	});

	it('returns an entry for every target, so a surface never renders a hole', async () => {
		const profiles = await loadReceivingProfiles('u1', [
			{ id: 'm1', userId: 'u2' },
			{ id: 'm2', userId: null }
		]);

		expect(Object.keys(profiles).sort()).toEqual(['m1', 'm2']);
	});
});
