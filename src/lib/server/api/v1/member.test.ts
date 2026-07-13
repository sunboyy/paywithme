// Unit tests for the v1 Member DTO mapper (PLAN §16.4).
// Asserts the §16.4 field set is projected faithfully for linked, unlinked, and
// deactivated members.

import { describe, it, expect } from 'vitest';
import type { MemberListItem } from '$lib/server/members';
import { toMemberDto } from './member';

function makeMember(overrides: Partial<MemberListItem> = {}): MemberListItem {
	return {
		id: 'm1',
		displayName: 'Alex',
		userId: 'user-1',
		deactivatedAt: null,
		isLinked: true,
		...overrides
	};
}

describe('toMemberDto', () => {
	it('maps a linked, active member', () => {
		const dto = toMemberDto(makeMember());
		expect(dto).toEqual({
			id: 'm1',
			displayName: 'Alex',
			userId: 'user-1',
			deactivatedAt: null,
			isLinked: true
		});
	});

	it('carries null userId + isLinked=false for an unlinked slot', () => {
		const dto = toMemberDto(makeMember({ userId: null, isLinked: false }));
		expect(dto.userId).toBeNull();
		expect(dto.isLinked).toBe(false);
	});

	it('carries deactivatedAt for a soft-deactivated member', () => {
		const dto = toMemberDto(makeMember({ deactivatedAt: '2026-03-01T00:00:00.000Z' }));
		expect(dto.deactivatedAt).toBe('2026-03-01T00:00:00.000Z');
	});
});
