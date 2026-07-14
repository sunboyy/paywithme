// Unit tests for the group view (ADR-0006): the name is untrusted text, attributed
// to whoever created the group, and the internal soft-delete marker never appears.

import { describe, it, expect } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import type { Group } from '$lib/server/groups';
import { toGroupView } from './group';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	name: 'test key',
	userId: 'user_me',
	permissions: null
};

function group(overrides: Partial<Group> = {}): Group {
	return {
		id: 'grp_1',
		name: 'Japan Trip',
		settlementCurrency: 'THB',
		createdBy: 'user_me',
		createdAt: new Date('2026-07-01T10:00:00.000Z'),
		deletedAt: null,
		...overrides
	} as Group;
}

describe('toGroupView', () => {
	it('wraps the name and attributes it to the caller when the CALLER created the group', () => {
		expect(toGroupView(group(), principal)).toEqual({
			id: 'grp_1',
			name: {
				_untrusted: true,
				value: 'Japan Trip',
				author: { kind: 'you', userId: 'user_me' }
			},
			settlementCurrency: 'THB',
			createdAt: '2026-07-01T10:00:00.000Z'
		});
	});

	it('attributes a group SOMEONE ELSE created to THEM — the model must know whose words these are', () => {
		const view = toGroupView(group({ createdBy: 'user_mallory' }), principal);
		expect(view.name.author).toEqual({ kind: 'member', userId: 'user_mallory' });
	});

	it('never serves the internal soft-delete marker', () => {
		expect(toGroupView(group({ deletedAt: new Date() }), principal)).not.toHaveProperty(
			'deletedAt'
		);
	});
});
