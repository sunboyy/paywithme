// Unit test for GET /api/v1/currencies (PLAN §16.4, §7.5.1).
//
// Serves the canonical `$lib/money` `CURRENCIES` table projected to the documented
// `{ code, exponent, symbol }` DTO. We assert the 200 status, that every canonical
// currency is present with the right triple, and that the internal `name` field is
// DROPPED (the owned-DTO seam keeping UI-only fields off the wire).

import { describe, it, expect } from 'vitest';
import { GET } from './+server';
import { CURRENCIES } from '$lib/money';

/** Minimal RequestEvent — the handler reads nothing off it. */
function makeEvent() {
	return {} as unknown as Parameters<typeof GET>[0];
}

async function read(res: Response) {
	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		body: await res.json()
	};
}

describe('GET /api/v1/currencies', () => {
	it('returns 200 with every currency as { code, exponent, symbol }', async () => {
		const { status, contentType, body } = await read((await GET(makeEvent())) as Response);
		expect(status).toBe(200);
		expect(contentType).toContain('application/json');
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(CURRENCIES.length);
		// First row matches the canonical data exactly (order preserved).
		expect(body[0]).toEqual({
			code: CURRENCIES[0].code,
			exponent: CURRENCIES[0].exponent,
			symbol: CURRENCIES[0].symbol
		});
	});

	it('drops the internal UI-only `name` field', async () => {
		const { body } = await read((await GET(makeEvent())) as Response);
		for (const row of body) {
			expect(row).not.toHaveProperty('name');
			expect(Object.keys(row).sort()).toEqual(['code', 'exponent', 'symbol']);
		}
	});
});
