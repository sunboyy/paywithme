import { describe, it, expect } from 'vitest';
import { actionLabel, entityTypeLabel } from './activity-labels';
import { GROUP_AUDIT_ENTITY_TYPES } from './server/audit';

// The audit trail's presentation vocabulary (PLAN §12.1). Added with Captures
// (issue #49), because that is the first entity whose INTERNAL name may never
// reach a screen: "Capture" is internal vocabulary and the UI says "Not recorded
// yet" (CONTEXT.md / PLAN §7.7).

describe('entityTypeLabel', () => {
	it('never renders the internal word "capture"', () => {
		expect(entityTypeLabel('capture')).toBe('Not recorded yet');
		expect(entityTypeLabel('capture').toLowerCase()).not.toContain('capture');
	});

	it('labels every GROUP-scoped entity type the feed can filter by', () => {
		// A kind with no label would fall back to its raw stored value — which is
		// exactly the leak this map exists to prevent, so nothing may be missing.
		for (const entityType of GROUP_AUDIT_ENTITY_TYPES) {
			expect(entityTypeLabel(entityType), `no label for '${entityType}'`).not.toBe(entityType);
		}
	});

	it('falls back to the raw value for an unknown kind', () => {
		expect(entityTypeLabel('spaceship')).toBe('spaceship');
	});
});

describe('actionLabel', () => {
	it("labels a Capture's two endings without naming the entity", () => {
		expect(actionLabel('resolve')).toBe('recorded');
		expect(actionLabel('discard')).toBe('discarded');
	});

	it('falls back to the raw verb for an unknown action', () => {
		expect(actionLabel('frobnicate')).toBe('frobnicate');
	});
});
