import { describe, it, expect } from 'vitest';
import { cn } from '$lib/utils';

describe('cn', () => {
	it('merges multiple class name arguments into one string', () => {
		expect(cn('px-2', 'text-sm')).toBe('px-2 text-sm');
	});

	it('resolves conflicting Tailwind utilities, keeping the last one (tailwind-merge)', () => {
		expect(cn('px-2', 'px-4')).toBe('px-4');
		expect(cn('text-sm', 'text-base')).toBe('text-base');
	});

	it('drops falsy / conditional values (clsx)', () => {
		expect(cn('font-bold', false, null, undefined, '')).toBe('font-bold');
		const isActive = false;
		expect(cn('btn', isActive && 'btn-active')).toBe('btn');
	});

	it('keeps a conditional class when its condition is truthy', () => {
		const isActive = true;
		expect(cn('btn', isActive && 'btn-active')).toBe('btn btn-active');
	});

	it('flattens array and object class inputs (clsx)', () => {
		expect(cn(['flex', 'items-center'], { 'gap-2': false, 'gap-4': true })).toBe(
			'flex items-center gap-4'
		);
	});
});
