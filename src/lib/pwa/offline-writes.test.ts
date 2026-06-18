import { describe, it, expect } from 'vitest';
import { writeDisabled, OFFLINE_WRITE_MESSAGE } from './offline-writes';

// Unit tests for the pure "disable writes while offline" helper (PLAN §11 —
// no offline creation in v1). Pure logic, no DOM.

describe('writeDisabled (PLAN §11 — disable writes offline)', () => {
	it('enabled when online and not submitting', () => {
		expect(writeDisabled(false)).toEqual({ disabled: false, reason: null });
		expect(writeDisabled(false, false)).toEqual({ disabled: false, reason: null });
	});

	it('disabled with the offline reason when offline (regardless of submitting)', () => {
		expect(writeDisabled(true)).toEqual({ disabled: true, reason: OFFLINE_WRITE_MESSAGE });
		expect(writeDisabled(true, true)).toEqual({ disabled: true, reason: OFFLINE_WRITE_MESSAGE });
	});

	it('disabled (no spoken reason) while submitting but online', () => {
		expect(writeDisabled(false, true)).toEqual({ disabled: true, reason: null });
	});

	it('offline reason takes priority over the in-flight state', () => {
		const result = writeDisabled(true, true);
		expect(result.disabled).toBe(true);
		expect(result.reason).toBe(OFFLINE_WRITE_MESSAGE);
	});

	it('an extra `force` reason disables even when online + idle', () => {
		expect(writeDisabled(false, false, true)).toEqual({ disabled: true, reason: null });
	});

	it('never relaxes: offline + force stays disabled with the offline reason', () => {
		expect(writeDisabled(true, false, true)).toEqual({
			disabled: true,
			reason: OFFLINE_WRITE_MESSAGE
		});
	});

	it('exposes a non-empty, color-independent message', () => {
		expect(OFFLINE_WRITE_MESSAGE).toMatch(/offline/i);
		expect(OFFLINE_WRITE_MESSAGE.length).toBeGreaterThan(0);
	});
});
