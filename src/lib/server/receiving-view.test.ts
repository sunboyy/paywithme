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
//   3. THE VIEWER'S OWN PROFILE is the one target read with `listOwn`, and an
//      empty one is `own-empty` — the state that becomes a link rather than a
//      sentence (issue #87; PLAN §17.4 case 3) — but ONLY where the caller opted
//      in. Off by default is the whole safeguard: a surface that has not
//      established the viewer is owed money would be asking for bank details with
//      nothing behind the ask, which is the onboarding step PLAN §17.4 refuses.
//
// The rail registry is REAL here: rendering a stored row is exactly what this
// module does, and mocking the rails would leave the interesting part untested.

const { listForViewer, listOwn } = vi.hoisted(() => ({
	listForViewer: vi.fn(),
	listOwn: vi.fn()
}));

vi.mock('./receiving-methods', () => ({ listForViewer, listOwn }));

import {
	loadReceivingProfiles,
	toMethodView,
	toProfileView,
	type ReceivingAmount
} from './receiving-view';

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
	listOwn.mockReset();
	listOwn.mockResolvedValue([]);
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

	it('reports the VIEWER’s own empty profile as `own-empty` when asked (PLAN §17.4 case 3)', () => {
		// Same emptiness, different reader: this one can fix it.
		expect(toProfileView([], true)).toEqual({ state: 'own-empty' });
	});

	it('says nothing special about the viewer’s own profile once it has a method', () => {
		// Seeing your own details here is seeing what the payer sees — no prompt.
		expect(toProfileView([row()], true).state).toBe('methods');
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

	it('reads the viewer’s OWN profile as its owner, not as a stranger might', async () => {
		// Whether I can see myself is not the question — the prompt claims my profile
		// is empty, so it has to be my profile that was read.
		await loadReceivingProfiles('u1', [{ id: 'm1', userId: 'u1' }], {
			promptViewerToAdd: true
		});

		expect(listOwn).toHaveBeenCalledWith('u1');
		expect(listForViewer).not.toHaveBeenCalled();
	});

	it('asks the viewer to add their details only where the caller opted in', async () => {
		const profiles = await loadReceivingProfiles('u1', [{ id: 'm1', userId: 'u1' }], {
			promptViewerToAdd: true
		});

		expect(profiles.m1).toEqual({ state: 'own-empty' });
	});

	it('does NOT ask by default, so an ungated surface cannot nag the viewer', async () => {
		// The members roster lists everyone regardless of balance. Nothing there says
		// anyone owes the viewer anything, so their own blank reads like any other
		// blank — PLAN §17.4 rules out the unprompted ask.
		const profiles = await loadReceivingProfiles('u1', [{ id: 'm1', userId: 'u1' }]);

		expect(profiles.m1).toEqual({ state: 'no-methods' });
		// Still read as its owner — the opt-in governs the COPY, not the query.
		expect(listOwn).toHaveBeenCalledWith('u1');
	});

	it('leaves everyone else’s empty profile as the dead-end `no-methods`', async () => {
		// Only the viewer gets the "add yours" link; a co-member's blank is `no-methods`
		// in the same call.
		const profiles = await loadReceivingProfiles(
			'u1',
			[
				{ id: 'm1', userId: 'u1' },
				{ id: 'm3', userId: 'u2' }
			],
			{ promptViewerToAdd: true }
		);

		expect(profiles.m1).toEqual({ state: 'own-empty' });
		expect(profiles.m3).toEqual({ state: 'no-methods' });
	});

	it('hands the viewer their own methods when they have some', async () => {
		listOwn.mockResolvedValue([row({ userId: 'u1' })]);

		const profiles = await loadReceivingProfiles('u1', [{ id: 'm1', userId: 'u1' }], {
			promptViewerToAdd: true
		});

		expect(profiles.m1.state).toBe('methods');
	});

	it('returns an entry for every target, so a surface never renders a hole', async () => {
		const profiles = await loadReceivingProfiles('u1', [
			{ id: 'm1', userId: 'u2' },
			{ id: 'm2', userId: null }
		]);

		expect(Object.keys(profiles).sort()).toEqual(['m1', 'm2']);
	});
});

describe('the code the payer scans (issue #88; PLAN §17.4)', () => {
	/** ฿1,200.00 in the integer minor units the ledger stores. */
	const THB: ReceivingAmount = { amount: 120000, currency: 'THB' };

	/** The methods of a profile built for one target. */
	async function methodsFor(amount?: ReceivingAmount) {
		listForViewer.mockResolvedValue([PROMPTPAY, row()]);
		const profiles = await loadReceivingProfiles('u1', [{ id: 'm3', userId: 'u2', amount }]);
		const profile = profiles.m3;
		if (profile.state !== 'methods') throw new Error(`expected methods, got ${profile.state}`);
		return profile.methods;
	}

	it('draws a code for a rail that can encode the transfer', async () => {
		const [promptpay] = await methodsFor(THB);

		expect(promptpay.qr?.size).toBeGreaterThan(0);
		expect(promptpay.qr?.path).toMatch(/^M\d/);
		// The caption is formatted from the SAME minor units the payload encoded, so
		// the figure on screen cannot claim one amount while the code carries another.
		expect(promptpay.qr?.amountFormatted).toBe('฿1,200.00');
	});

	it('draws none for a rail that cannot, without hiding the details', async () => {
		// `th_bank_account` has no encoder (the #82 result). The account number is
		// still the answer — a missing code costs the scan, never the transfer.
		const [, bank] = await methodsFor(THB);

		expect(bank.qr).toBeNull();
		expect(bank.fields?.some((f) => f.value === '1234567890')).toBe(true);
	});

	it('draws none in any currency but the rail’s own', async () => {
		// The Thai payload hard-codes THB. A euro figure inside it is one a banking
		// app reads as baht, so the only safe answer is no code at all.
		const [promptpay] = await methodsFor({ amount: 120000, currency: 'EUR' });

		expect(promptpay.qr).toBeNull();
		expect(promptpay.fields?.some((f) => f.value === '0812345678')).toBe(true);
	});

	it('draws none where the surface names no amount', async () => {
		// The members roster lists people, not debts. A code with no figure, on a
		// screen with no figure, invites the payer to assume one is in there.
		const methods = await methodsFor();

		for (const method of methods) expect(method.qr).toBeNull();
	});

	it('gives one creditor’s two transfers two different codes, from one read', async () => {
		// Two people can owe the same person two different amounts. Each row's code
		// carries its own figure — and both come out of a single visibility read.
		listForViewer.mockResolvedValue([PROMPTPAY]);

		const profiles = await loadReceivingProfiles('u1', [
			{ id: 'm2→m1', userId: 'u2', amount: { amount: 12000, currency: 'THB' } },
			{ id: 'm3→m1', userId: 'u2', amount: { amount: 3000, currency: 'THB' } }
		]);

		const first = profiles['m2→m1'];
		const second = profiles['m3→m1'];
		if (first.state !== 'methods' || second.state !== 'methods')
			throw new Error('expected methods');

		expect(first.methods[0].qr?.amountFormatted).toBe('฿120.00');
		expect(second.methods[0].qr?.amountFormatted).toBe('฿30.00');
		expect(first.methods[0].qr?.path).not.toBe(second.methods[0].qr?.path);
		expect(listForViewer).toHaveBeenCalledTimes(1);
	});

	it('draws none over details the rail refuses to render', async () => {
		// Same rule as the fields: half a method is worse than none when the next step
		// is a transfer.
		listForViewer.mockResolvedValue([
			row({ id: 'rm9', rail: 'th_promptpay', details: { proxyType: 'mobile' } })
		]);

		const profiles = await loadReceivingProfiles('u1', [{ id: 'm3', userId: 'u2', amount: THB }]);
		const profile = profiles.m3;
		if (profile.state !== 'methods') throw new Error('expected methods');

		expect(profile.methods[0].fields).toBeNull();
		expect(profile.methods[0].qr).toBeNull();
	});
});
