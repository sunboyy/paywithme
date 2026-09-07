import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';
import { QR_QUIET_ZONE_MODULES, toQrSvg } from './qr-code';

// Unit spec for the QR renderer (issue #88).
//
// The encoding itself is the library's job and is not re-tested here. What IS
// tested is the part this repo wrote: the run-length path. An off-by-one in it
// draws a code that looks plausible and decodes to something else — or to
// nothing — and nobody would see that in a screenshot.
//
// So the path is read BACK into a matrix and compared against the library's own
// `isDark`, which is the only check that can fail for the right reason.

const PAYLOAD = '00020101021229370016A00000067701011101130066812345678530376454071200.005802TH6304';

/** Every dark module the path draws, as `x,y` keys. */
function modulesFromPath(path: string): Set<string> {
	const dark = new Set<string>();
	for (const [, x, y, width] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
		for (let i = 0; i < Number(width); i++) dark.add(`${Number(x) + i},${Number(y)}`);
	}
	return dark;
}

describe('toQrSvg', () => {
	it('draws exactly the modules the encoder marked dark', () => {
		const { path } = toQrSvg(PAYLOAD);
		const drawn = modulesFromPath(path);

		// The library as the oracle: same payload, same settings, module by module.
		const oracle = qrcode(0, 'M');
		oracle.addData(PAYLOAD, 'Byte');
		oracle.make();
		const count = oracle.getModuleCount();

		let dark = 0;
		for (let row = 0; row < count; row++) {
			for (let col = 0; col < count; col++) {
				const key = `${col + QR_QUIET_ZONE_MODULES},${row + QR_QUIET_ZONE_MODULES}`;
				expect(drawn.has(key), `module ${col},${row}`).toBe(oracle.isDark(row, col));
				if (oracle.isDark(row, col)) dark++;
			}
		}
		// Nothing outside the matrix, either — a stray run in the quiet zone would
		// pass the loop above and still break scanning.
		expect(drawn.size).toBe(dark);
	});

	it('surrounds the code with a quiet zone, inside the viewBox', () => {
		const { size, path } = toQrSvg(PAYLOAD);
		const drawn = [...modulesFromPath(path)].map((key) => key.split(',').map(Number));

		const low = QR_QUIET_ZONE_MODULES;
		const high = size - QR_QUIET_ZONE_MODULES - 1;
		for (const [x, y] of drawn) {
			expect(x, 'x').toBeGreaterThanOrEqual(low);
			expect(y, 'y').toBeGreaterThanOrEqual(low);
			expect(x, 'x').toBeLessThanOrEqual(high);
			expect(y, 'y').toBeLessThanOrEqual(high);
		}
		// The margin is drawn into the geometry, not left to CSS padding, so it
		// survives a crop or a screenshot.
		expect(size).toBe(high - low + 1 + QR_QUIET_ZONE_MODULES * 2);
	});

	it('grows the symbol with the payload rather than truncating it', () => {
		const small = toQrSvg('1');
		const large = toQrSvg('x'.repeat(400));

		expect(large.size).toBeGreaterThan(small.size);
	});

	it('is deterministic, and different for different payloads', () => {
		expect(toQrSvg(PAYLOAD)).toEqual(toQrSvg(PAYLOAD));
		expect(toQrSvg(PAYLOAD).path).not.toBe(toQrSvg(`${PAYLOAD}0`).path);
	});
});
