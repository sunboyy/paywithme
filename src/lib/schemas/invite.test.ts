import { describe, it, expect } from 'vitest';
import { createInviteSchema, acceptInviteSchema } from './invite';

// Unit tests for the shared invite schemas (PLAN §6.2 — member-agnostic links).
//
//   - `createInviteSchema` is now a trivial empty-object schema (creation carries
//     no target member; the link is member-agnostic).
//   - `acceptInviteSchema` models the invitee's accept-time CHOICE: `new` needs no
//     member, `existing` REQUIRES a non-empty `memberId`; bad modes are rejected.

describe('createInviteSchema (member-agnostic — no target input)', () => {
	it('accepts an empty object (no input needed beyond the action)', () => {
		expect(createInviteSchema.safeParse({}).success).toBe(true);
	});

	it('ignores any stray fields (no memberId in the model)', () => {
		const parsed = createInviteSchema.parse({ memberId: 'm1' } as Record<string, unknown>);
		expect(parsed).not.toHaveProperty('memberId');
	});
});

describe('acceptInviteSchema (PLAN §6.2 step 3 — join choice)', () => {
	it("accepts { mode: 'new' } (no memberId required)", () => {
		const result = acceptInviteSchema.safeParse({ mode: 'new' });
		expect(result.success).toBe(true);
	});

	it("accepts { mode: 'existing', memberId: 'm1' }", () => {
		const result = acceptInviteSchema.safeParse({ mode: 'existing', memberId: 'm1' });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.memberId).toBe('m1');
	});

	it("rejects { mode: 'existing' } with a missing memberId", () => {
		expect(acceptInviteSchema.safeParse({ mode: 'existing' }).success).toBe(false);
	});

	it("rejects { mode: 'existing', memberId: '' } (empty/whitespace-only)", () => {
		expect(acceptInviteSchema.safeParse({ mode: 'existing', memberId: '' }).success).toBe(false);
		expect(acceptInviteSchema.safeParse({ mode: 'existing', memberId: '   ' }).success).toBe(false);
	});

	it('rejects an unknown / missing mode', () => {
		expect(acceptInviteSchema.safeParse({ mode: 'bogus' }).success).toBe(false);
		expect(acceptInviteSchema.safeParse({}).success).toBe(false);
	});
});
