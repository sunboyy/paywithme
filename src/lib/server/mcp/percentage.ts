// Percentages on the MCP wire are human percentages ("7" means 7%), while the
// transaction domain stores integer basis points (700 means 7%). Keep both
// directions string/integer based so adapters never need floating-point math.

/** Convert an MCP percentage string (at most two decimal places) to basis points. */
export function percentStringToBasisPoints(percent: string): number {
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(percent);
	if (match === null) {
		throw new Error('Percent must be a plain decimal string with at most 2 decimal places.');
	}

	const whole = Number(match[1]);
	const fraction = (match[2] ?? '').padEnd(2, '0');
	const basisPoints = whole * 100 + Number(fraction || '0');
	if (!Number.isSafeInteger(basisPoints) || basisPoints > 10_000) {
		throw new Error('Percent must be between "0" and "100".');
	}
	return basisPoints;
}

/** Convert stored basis points to the shortest round-trippable human percentage string. */
export function basisPointsToPercentString(basisPoints: number): string {
	if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
		throw new Error('Basis points must be a whole number between 0 and 10000.');
	}
	const whole = Math.floor(basisPoints / 100);
	const fraction = String(basisPoints % 100)
		.padStart(2, '0')
		.replace(/0+$/, '');
	return fraction === '' ? String(whole) : `${whole}.${fraction}`;
}
