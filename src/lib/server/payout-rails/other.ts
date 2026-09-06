// The `other` rail: a label plus free text (PLAN §17.2).
//
// The escape hatch for anything this app does not model — a foreign bank, a
// payment link. It carries NO holder name (there is nothing to compare against a
// bank's record) and NEVER a QR (there is nothing to encode).

import { defineRail } from './types';
import { otherDetailsSchema } from '$lib/schemas/receiving-method';

export const otherRail = defineRail({
	id: 'other',
	label: 'Other',
	detailsSchema: otherDetailsSchema,
	// Member-authored on both sides: the label is whatever the owner called it, and
	// the text is whatever they pasted. Wrap it wherever it reaches an agent
	// (ADR-0003 / ADR-0004) — formatting it does not make it trusted.
	format: ({ label, text }) => `${label} · ${text}`
});
