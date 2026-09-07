// The Thai QR payload — the `th_promptpay` rail's own encoder (issue #88;
// PLAN §17.2, §17.4; ADR-0017).
//
// Only `./th-promptpay.ts` imports this. The payload shape is a rail capability,
// not shared code: Thailand and Brazil use EMVCo Merchant-Presented Mode, the EU
// uses EPC069-12 (plain text, IBAN-only, EUR-only, not EMVCo at all) and India a
// `upi://` URI. They are mutually unintelligible, so an encoder belongs to the
// rail whose `details` it reads and to nothing above it (ADR-0016). Callers ask
// the registry for a payload and get a string or `null`; nobody outside learns
// what is inside it.
//
// ── Verified, not derived (the #82 spike, against K PLUS and SCB EASY) ────────
// The structure below is what real bank QRs contain, confirmed by reproducing a
// bank-issued payload byte for byte (see `thai-qr.test.ts`). Field ORDER and the
// point-of-initiation value are NOT load-bearing — three orders and both `11` and
// `12` scanned in the wild — so one of each is chosen here and pinned by a test,
// rather than left to drift.
//
// ── THB only, and that is correctness ────────────────────────────────────────
// Tag 53 is hard-coded to ISO 4217 numeric `764`. There is no way to say "this
// figure is euros" in a payload a Thai banking app reads, so a non-THB transfer
// must produce NO QR at all rather than a code carrying a foreign figure into a
// baht field. That gate lives in the rail (`th-promptpay.ts`), which is the only
// caller; this module owns the amount's FORMAT, not the decision to encode one.
//
// ── A QR is obfuscation, never protection ────────────────────────────────────
// The proxy is inside the code in plain digits. Anyone who screenshots and
// decodes it has the number. Nothing here or above it may imply otherwise.

import type { PromptPayProxyType } from '$lib/schemas/receiving-method';

/** The only currency this payload can carry — see the header. */
export const THAI_QR_CURRENCY = 'THB';

/**
 * THB's minor-unit exponent, which fixes tag 54 at two decimals.
 *
 * A constant rather than a lookup, because the two decimals are the Thai QR
 * spec's and not our currency table's. A drift guard in the spec asserts the app's
 * own THB row still agrees, so the two can never disagree unnoticed.
 */
export const THAI_QR_AMOUNT_EXPONENT = 2;

/** ISO 4217 numeric for THB (tag 53). */
const CURRENCY_NUMERIC = '764';

/** ISO 3166-1 alpha-2 (tag 58). */
const COUNTRY_CODE = 'TH';

/** EMVCo payload format indicator (tag 00) — version 1. */
const PAYLOAD_FORMAT_INDICATOR = '01';

/**
 * Point of initiation (tag 01): `11` static/reusable, `12` one-time.
 *
 * Both scanned during the spike, so this is not load-bearing. It follows the
 * amount because that is what the values MEAN: a payload naming a figure is spent
 * once, one without a figure is a reusable code.
 */
const POINT_OF_INITIATION_STATIC = '11';
const POINT_OF_INITIATION_ONE_TIME = '12';

/** PromptPay's application id, the first sub-tag of tag 29. */
const PROMPTPAY_AID = 'A000000677010111';

/** Tag 29's own sub-tag ids: the AID, then one per proxy type. */
const AID_SUB_TAG = '00';
const PROXY_SUB_TAG: Record<PromptPayProxyType, string> = {
	mobile: '01',
	national_id: '02',
	ewallet: '03'
};

/** Tag ids assembled in `encodeThaiQrPayload`. */
const TAG_PAYLOAD_FORMAT = '00';
const TAG_POINT_OF_INITIATION = '01';
const TAG_MERCHANT_ACCOUNT_PROMPTPAY = '29';
const TAG_CURRENCY = '53';
const TAG_AMOUNT = '54';
const TAG_COUNTRY = '58';
const TAG_CRC = '63';

/** EMVCo's cap on tag 54 — an amount longer than this cannot be encoded at all. */
const AMOUNT_MAX_LENGTH = 13;

/** A mobile proxy is carried as `0066` + the subscriber's last 9 digits. */
const MOBILE_SUBSCRIBER_DIGITS = 9;
const MOBILE_COUNTRY_PREFIX = '0066';
/** The stored forms that yield those 9 digits: `0812345678` or `812345678`. */
const MOBILE_STORED_DIGITS = [MOBILE_SUBSCRIBER_DIGITS, MOBILE_SUBSCRIBER_DIGITS + 1];

/** A Thai national ID is exactly 13 digits; a bank-issued e-wallet id exactly 15. */
const NATIONAL_ID_DIGITS = 13;
const EWALLET_DIGITS = 15;

const utf8 = new TextEncoder();

/**
 * One EMVCo field: two-digit id, two-digit LENGTH, value.
 *
 * The length is the value's BYTE length, not its character count — every value
 * this module builds is ASCII, so the two agree, but reading the length off the
 * bytes is what keeps that an observation rather than an assumption.
 *
 * @throws if the value cannot be described by a two-digit length. A field that
 * long is a programming error upstream, not a payload to emit with a wrong length
 * that every scanner would then misread.
 */
export function encodeTlv(id: string, value: string): string {
	const length = utf8.encode(value).length;
	if (length > 99) throw new RangeError(`EMVCo field ${id} is too long to encode: ${length} bytes`);
	return `${id}${String(length).padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE (polynomial `0x1021`, initial value `0xFFFF`), as four
 * uppercase hex digits.
 *
 * Computed over the whole payload INCLUDING the trailing `6304` — the CRC field's
 * own id and length are part of what is checksummed, which is the detail a
 * hand-rolled implementation usually gets wrong. Pinned against the standard
 * `123456789` → `29B1` vector.
 */
export function crc16CcittFalse(input: string): string {
	let crc = 0xffff;
	for (const byte of utf8.encode(input)) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 0x8000) === 0 ? crc << 1 : (crc << 1) ^ 0x1021;
			crc &= 0xffff;
		}
	}
	return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Integer minor units as a fixed-point decimal string — `12345` → `"123.45"`.
 *
 * Integer math only (CLAUDE.md, PLAN §7.5): dividing by 100 in floating point is
 * how an amount ends up one satang out in a field a bank reads as money.
 */
export function formatMinorUnits(amount: number, exponent: number): string {
	const factor = 10 ** exponent;
	const whole = Math.floor(amount / factor);
	const fraction = amount - whole * factor;
	return exponent === 0 ? String(whole) : `${whole}.${String(fraction).padStart(exponent, '0')}`;
}

/**
 * The proxy as tag 29 carries it, or `null` when the stored value cannot be one.
 *
 * The rail's schema is deliberately loose — digits only, 9–15, no per-type rule,
 * because a tighter rule goes stale and catches nothing that matters (PLAN §17.2).
 * That is the right rule for a number a person will TYPE, and the wrong one for a
 * number a scanner will read: a 12-digit "national ID" produces a payload that
 * every banking app rejects at the counter. So the length is checked HERE, where
 * the answer can be "no QR" — the digits stay on screen, copyable, exactly as
 * before.
 */
function encodeProxy(proxyType: PromptPayProxyType, proxyValue: string): string | null {
	if (!/^[0-9]+$/.test(proxyValue)) return null;

	switch (proxyType) {
		case 'mobile':
			// The last 9 digits, so a stored `0812345678` and a stored `812345678` reach
			// the same subscriber. Anything longer is a typo, not a phone number, and
			// silently trimming it to nine would encode somebody else's.
			return MOBILE_STORED_DIGITS.includes(proxyValue.length)
				? `${MOBILE_COUNTRY_PREFIX}${proxyValue.slice(-MOBILE_SUBSCRIBER_DIGITS)}`
				: null;
		case 'national_id':
			return proxyValue.length === NATIONAL_ID_DIGITS ? proxyValue : null;
		case 'ewallet':
			return proxyValue.length === EWALLET_DIGITS ? proxyValue : null;
	}
}

/** What one payload needs: whose proxy, and (optionally) for how much. */
export type ThaiQrRequest = {
	readonly proxyType: PromptPayProxyType;
	/** The proxy exactly as stored on the method (digits only). */
	readonly proxyValue: string;
	/**
	 * THB in integer minor units — satang (PLAN §7.5). Omitted yields an amountless
	 * code, which is what a static bank-issued QR is; the rail always passes one.
	 */
	readonly amount?: number;
};

/**
 * The scannable payload, or `null` when this method cannot produce one.
 *
 * `null` is a normal answer, never an error: a proxy whose length no bank would
 * accept, or an amount outside what tag 54 can carry. A QR that fails to scan is
 * worse than no QR, because the payer finds out at the moment they are trying to
 * pay (ADR-0016) — so the failure is "no code", with the number still on screen.
 */
export function encodeThaiQrPayload({
	proxyType,
	proxyValue,
	amount
}: ThaiQrRequest): string | null {
	const proxy = encodeProxy(proxyType, proxyValue);
	if (!proxy) return null;

	let amountField = '';
	if (amount !== undefined) {
		// Minor units, so a non-integer means someone did float math upstream.
		if (!Number.isSafeInteger(amount) || amount <= 0) return null;
		const formatted = formatMinorUnits(amount, THAI_QR_AMOUNT_EXPONENT);
		if (formatted.length > AMOUNT_MAX_LENGTH) return null;
		amountField = encodeTlv(TAG_AMOUNT, formatted);
	}

	const merchantAccount =
		encodeTlv(AID_SUB_TAG, PROMPTPAY_AID) + encodeTlv(PROXY_SUB_TAG[proxyType], proxy);

	const body =
		encodeTlv(TAG_PAYLOAD_FORMAT, PAYLOAD_FORMAT_INDICATOR) +
		encodeTlv(
			TAG_POINT_OF_INITIATION,
			amountField ? POINT_OF_INITIATION_ONE_TIME : POINT_OF_INITIATION_STATIC
		) +
		encodeTlv(TAG_MERCHANT_ACCOUNT_PROMPTPAY, merchantAccount) +
		encodeTlv(TAG_CURRENCY, CURRENCY_NUMERIC) +
		amountField +
		encodeTlv(TAG_COUNTRY, COUNTRY_CODE);

	// The CRC covers its own id and length, so they are appended BEFORE it is taken.
	const checksummed = `${body}${TAG_CRC}04`;
	return `${checksummed}${crc16CcittFalse(checksummed)}`;
}
