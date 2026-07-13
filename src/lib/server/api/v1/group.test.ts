// Unit tests for the v1 Group DTO mapper (PLAN §16.4).
// Asserts `deletedAt` is dropped, `createdAt` is ISO-serialized, and every other
// field is carried faithfully.

import { describe, it, expect } from 'vitest';
import type { Group } from '$lib/server/groups';
import { toGroupDto } from './group';

function makeGroup(overrides: Partial<Group> = {}): Group {
	return {
		id: 'g1',
		name: 'Trip to Osaka',
		settlementCurrency: 'JPY',
		createdBy: 'user-1',
		createdAt: new Date('2026-01-02T03:04:05.000Z'),
		deletedAt: null,
		...overrides
	};
}

describe('toGroupDto', () => {
	it('maps every served field', () => {
		const dto = toGroupDto(makeGroup());
		expect(dto).toEqual({
			id: 'g1',
			name: 'Trip to Osaka',
			settlementCurrency: 'JPY',
			createdBy: 'user-1',
			createdAt: '2026-01-02T03:04:05.000Z'
		});
	});

	it('serializes createdAt Date to an ISO string', () => {
		const dto = toGroupDto(makeGroup({ createdAt: new Date('2026-07-10T12:00:00.000Z') }));
		expect(dto.createdAt).toBe('2026-07-10T12:00:00.000Z');
		expect(typeof dto.createdAt).toBe('string');
	});

	it('drops deletedAt (internal soft-delete marker) even when set', () => {
		const dto = toGroupDto(makeGroup({ deletedAt: new Date('2026-02-01T00:00:00.000Z') }));
		expect(dto).not.toHaveProperty('deletedAt');
	});
});
