import { describe, expect, it } from 'vitest';
import {
	THAI_QR_AMOUNT_EXPONENT,
	crc16CcittFalse,
	encodeThaiQrPayload,
	encodeTlv,
	formatMinorUnits
} from './thai-qr';
import { getCurrency } from '$lib/money';

// Unit spec for the Thai QR payload (issue #88; PLAN §17.4; ADR-0017).
//
// Everything here is checked against something OUTSIDE this repo, because a QR is
// the one thing in the feature the app cannot verify for itself: a payload with a
// wrong length byte or a wrong CRC does not look broken, it looks like a code
// that "doesn't scan" — and the payer finds that out standing at the counter.
//
// The three anchors:
//   1. the standard CRC-16/CCITT-FALSE vector (`123456789` → `29B1`);
//   2. a bank-issued payload reproduced BYTE FOR BYTE, which is what proves the
//      TLV lengths, the AID, the sub-tag and the CRC's own coverage of `6304`
//      (captured in the #82 spike);
//   3. the structure re-parsed from the outside, so an assertion reads the
//      payload the way a scanner does rather than the way it was built.
//
// Field order and point of initiation are NOT load-bearing — the spike saw three
// orders and both `11` and `12` scan — but they are pinned anyway: the value of
// pinning an arbitrary choice is that changing it becomes deliberate.

/** A stored PromptPay method's digits, per proxy type. */
const MOBILE = '0812345678';
const NATIONAL_ID = '1234567890121';
const EWALLET = '004999087129812';

/** Read a payload back the way a scanner does: id, length, value, repeat. */
function parseTlv(payload: string): { id: string; value: string }[] {
	const fields: { id: string; value: string }[] = [];
	let cursor = 0;
	while (cursor < payload.length) {
		const id = payload.slice(cursor, cursor + 2);
		const length = Number(payload.slice(cursor + 2, cursor + 4));
		expect(Number.isInteger(length), `length of field ${id}`).toBe(true);
		fields.push({ id, value: payload.slice(cursor + 4, cursor + 4 + length) });
		cursor += 4 + length;
	}
	// A payload whose lengths do not add up would leave the cursor past the end —
	// exactly the failure a scanner reports as "invalid QR".
	expect(cursor).toBe(payload.length);
	return fields;
}

function field(payload: string, id: string): string | undefined {
	return parseTlv(payload).find((f) => f.id === id)?.value;
}

/** The payload a settle row produces: a mobile proxy and a real figure. */
function mobilePayload(amount = 120000): string {
	const payload = encodeThaiQrPayload({ proxyType: 'mobile', proxyValue: MOBILE, amount });
	expect(payload).not.toBeNull();
	return payload as string;
}

describe('crc16CcittFalse', () => {
	it('matches the standard check vector', () => {
		// The published check value for CRC-16/CCITT-FALSE. If this passes, the
		// polynomial, the initial value and the bit order are all right.
		expect(crc16CcittFalse('123456789')).toBe('29B1');
	});

	it('renders four uppercase hex digits', () => {
		for (const input of ['', 'A', '123456789', 'x'.repeat(200)]) {
			expect(crc16CcittFalse(input)).toMatch(/^[0-9A-F]{4}$/);
		}
	});

	it('changes when any byte of the payload changes', () => {
		expect(crc16CcittFalse('000201')).not.toBe(crc16CcittFalse('000202'));
	});
});

describe('encodeTlv', () => {
	it('writes a two-digit id, a two-digit length and the value', () => {
		expect(encodeTlv('53', '764')).toBe('5303764');
		expect(encodeTlv('58', 'TH')).toBe('5802TH');
	});

	it('measures the length in BYTES, not characters', () => {
		// No shipped field is non-ASCII, but the length a scanner trusts is the byte
		// count, so a multi-byte value must not be described as if it were shorter.
		expect(encodeTlv('62', '฿')).toBe('6203฿');
	});

	it('refuses a value no two-digit length can describe', () => {
		expect(() => encodeTlv('62', 'x'.repeat(100))).toThrow(RangeError);
	});
});

describe('formatMinorUnits', () => {
	it('formats satang as a two-decimal string with integer math', () => {
		expect(formatMinorUnits(120000, 2)).toBe('1200.00');
		expect(formatMinorUnits(100, 2)).toBe('1.00');
		expect(formatMinorUnits(5, 2)).toBe('0.05');
		expect(formatMinorUnits(1, 2)).toBe('0.01');
		expect(formatMinorUnits(999999999, 2)).toBe('9999999.99');
	});

	it('never loses a satang to floating point', () => {
		// 0.1 + 0.2 arithmetic in the amount field is money going to the wrong figure.
		for (let minor = 1; minor <= 500; minor++) {
			const [whole, fraction] = formatMinorUnits(minor, 2).split('.');
			expect(Number(whole) * 100 + Number(fraction)).toBe(minor);
		}
	});
});

describe('the amount field agrees with the app’s own THB', () => {
	it('uses the exponent the currency table gives THB', () => {
		// The two decimals are the Thai QR spec's, so they are a constant here rather
		// than a lookup — this is the guard that stops the two disagreeing silently.
		expect(getCurrency('THB')?.exponent).toBe(THAI_QR_AMOUNT_EXPONENT);
	});
});

describe('a real bank-issued payload', () => {
	it('is reproduced byte for byte', () => {
		// Captured from a bank's own receive QR during the #82 spike, and the reason
		// the spike's negative results are trustworthy: an encoder that reproduces
		// this exactly is not the reason anything failed to scan. No amount, so the
		// point of initiation is the static `11`.
		const payload = encodeThaiQrPayload({ proxyType: 'ewallet', proxyValue: EWALLET });

		expect(payload).toBe(
			'00020101021129390016A000000677010111031500499908712981253037645802TH6304CD82'
		);
	});
});

describe('encodeThaiQrPayload', () => {
	it('emits the fields in the pinned order', () => {
		// Not load-bearing (three orders scanned in the spike), pinned so that
		// changing it is a decision rather than a drift.
		expect(parseTlv(mobilePayload()).map((f) => f.id)).toEqual([
			'00',
			'01',
			'29',
			'53',
			'54',
			'58',
			'63'
		]);
	});

	it('declares EMVCo version 1, THB and Thailand', () => {
		const payload = mobilePayload();

		expect(field(payload, '00')).toBe('01');
		// 764 is hard-coded: there is no way to say "these are euros" in a field a
		// Thai banking app reads as baht, which is why a non-THB transfer gets no QR
		// at all — the rail's own gate, pinned in `index.test.ts`.
		expect(field(payload, '53')).toBe('764');
		expect(field(payload, '58')).toBe('TH');
	});

	it('marks an amount-bearing code one-time and an amountless one static', () => {
		expect(field(mobilePayload(), '01')).toBe('12');

		const staticPayload = encodeThaiQrPayload({ proxyType: 'mobile', proxyValue: MOBILE });
		expect(field(staticPayload as string, '01')).toBe('11');
		expect(field(staticPayload as string, '54')).toBeUndefined();
	});

	it('carries the amount as a two-decimal figure', () => {
		expect(field(mobilePayload(120000), '54')).toBe('1200.00');
		expect(field(mobilePayload(5), '54')).toBe('0.05');
	});

	it('ends with a CRC over the payload including `6304`', () => {
		const payload = mobilePayload();
		const upToCrc = payload.slice(0, -4);

		expect(upToCrc.endsWith('6304')).toBe(true);
		expect(payload.slice(-4)).toBe(crc16CcittFalse(upToCrc));
	});

	it('names PromptPay’s AID and the sub-tag for each proxy type', () => {
		const cases = [
			{ proxyType: 'mobile', proxyValue: MOBILE, expected: '01130066812345678' },
			{ proxyType: 'national_id', proxyValue: NATIONAL_ID, expected: `0213${NATIONAL_ID}` },
			{ proxyType: 'ewallet', proxyValue: EWALLET, expected: `0315${EWALLET}` }
		] as const;

		for (const { proxyType, proxyValue, expected } of cases) {
			const merchant = field(encodeThaiQrPayload({ proxyType, proxyValue, amount: 100 })!, '29');
			expect(merchant, proxyType).toBe(`0016A000000677010111${expected}`);
		}
	});

	it('carries a mobile proxy as 0066 plus its last nine digits', () => {
		// Stored with or without the leading zero, the same subscriber is encoded.
		const withZero = encodeThaiQrPayload({ proxyType: 'mobile', proxyValue: '0812345678' });
		const without = encodeThaiQrPayload({ proxyType: 'mobile', proxyValue: '812345678' });

		expect(field(withZero!, '29')).toContain('0066812345678');
		expect(withZero).toBe(without);
	});
});

describe('when no scannable code exists', () => {
	// `null` is the safe answer everywhere below: the digits stay on screen and
	// copyable, and the payer never scans something a bank will reject at the till.

	it('refuses a proxy whose length no bank would accept', () => {
		const tooShort = { proxyType: 'national_id', proxyValue: '123456789' } as const;
		const tooLong = { proxyType: 'mobile', proxyValue: '081234567890123' } as const;
		const notEwallet = { proxyType: 'ewallet', proxyValue: '1234567890123' } as const;

		expect(encodeThaiQrPayload(tooShort)).toBeNull();
		expect(encodeThaiQrPayload(tooLong)).toBeNull();
		expect(encodeThaiQrPayload(notEwallet)).toBeNull();
	});

	it('refuses anything but digits', () => {
		expect(encodeThaiQrPayload({ proxyType: 'mobile', proxyValue: '081-234-5678' })).toBeNull();
	});

	it('refuses an amount that is not positive integer minor units', () => {
		for (const amount of [0, -1, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
			expect(
				encodeThaiQrPayload({ proxyType: 'mobile', proxyValue: MOBILE, amount }),
				String(amount)
			).toBeNull();
		}
	});

	it('refuses an amount longer than the field can carry', () => {
		// 13 characters is EMVCo's cap on tag 54; ten digits of baht plus ".00" is
		// the last figure that fits.
		expect(field(mobilePayload(999_999_999_999), '54')).toBe('9999999999.99');
		expect(
			encodeThaiQrPayload({ proxyType: 'mobile', proxyValue: MOBILE, amount: 9_999_999_999_99 + 1 })
		).toBeNull();
	});
});
