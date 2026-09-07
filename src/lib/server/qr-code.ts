// Turning an opaque payload into a square of modules a phone camera can read
// (issue #88).
//
// Deliberately knows NOTHING about payments: it takes a string and answers
// geometry. The payload's shape belongs to the rail that built it
// (`payout-rails/thai-qr.ts`), and keeping the two apart is what stops a second
// country's encoder needing a second renderer.
//
// ── Why the server draws it ──────────────────────────────────────────────────
// The page is server-first (PLAN §10) and the payload is built in `load`, so the
// matrix is built there too: the code is in the HTML, it renders with JS
// disabled, and the QR library never reaches the client bundle. What crosses the
// wire is one SVG path — a few hundred bytes — rather than a thousand booleans or
// a base64 image.
//
// ── The quiet zone is part of the code ───────────────────────────────────────
// A QR with no margin is a QR that scanners struggle with, and CSS padding is not
// a substitute: it is outside the `viewBox`, so it disappears the moment anyone
// screenshots or crops the image. The margin is therefore drawn INTO the geometry.

import qrcode from 'qrcode-generator';

/** Modules of blank margin on every side — the spec's minimum. */
export const QR_QUIET_ZONE_MODULES = 4;

/**
 * Error correction level.
 *
 * `M` (~15% recoverable) is what payment QRs use: enough to survive a phone
 * screen's glare and a bit of moiré, without inflating a payload that is already
 * being read off a small display.
 */
const ERROR_CORRECTION_LEVEL = 'M';

/** A QR as pure geometry, in MODULE units — resolution is the renderer's choice. */
export type QrSvg = {
	/** Side of the square, quiet zone included: the `viewBox` is `0 0 size size`. */
	size: number;
	/** The `d` of one path covering every dark module. */
	path: string;
};

/**
 * Encode `payload` as an SVG path over a square `size` modules on a side.
 *
 * Dark modules only: the caller paints the light ground, and MUST paint it —
 * a transparent code over a dark theme is a code no scanner will read.
 *
 * @throws if the payload is too long for even a version-40 symbol. Callers that
 * cannot afford to fail (a page `load`) should treat that as "no code".
 */
export function toQrSvg(payload: string): QrSvg {
	// Type number 0 = pick the smallest version that fits.
	const qr = qrcode(0, ERROR_CORRECTION_LEVEL);
	qr.addData(payload, 'Byte');
	qr.make();

	const modules = qr.getModuleCount();
	const offset = QR_QUIET_ZONE_MODULES;
	let path = '';

	// One subpath per horizontal RUN of dark modules rather than one per module:
	// the same picture in a fraction of the bytes, and no seams between neighbours
	// the way per-module rects can show at fractional zoom levels.
	for (let row = 0; row < modules; row++) {
		let run = 0;
		for (let col = 0; col <= modules; col++) {
			if (col < modules && qr.isDark(row, col)) {
				run++;
				continue;
			}
			if (run > 0) {
				path += `M${col - run + offset} ${row + offset}h${run}v1h-${run}z`;
				run = 0;
			}
		}
	}

	return { size: modules + offset * 2, path };
}
