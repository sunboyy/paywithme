// The `other` rail: a label plus free text (PLAN §17.2).
//
// The escape hatch for anything this app does not model — a foreign bank, a
// payment link. It carries NO holder name (there is nothing to compare against a
// bank's record) and NEVER a QR (there is nothing to encode).

import { defineRail } from './types';
import {
	otherDetailsSchema,
	OTHER_LABEL_MAX_LENGTH,
	OTHER_TEXT_MAX_LENGTH
} from '$lib/schemas/receiving-method';

export const otherRail = defineRail({
	id: 'other',
	label: 'Other',
	detailsSchema: otherDetailsSchema,
	// Two fields, no holder name (there is nothing to compare) — the editor renders
	// whatever is listed here, so the absence needs no special case anywhere.
	fields: [
		{
			name: 'label',
			label: 'Label',
			control: 'text',
			maxLength: OTHER_LABEL_MAX_LENGTH,
			placeholder: 'e.g. Wise (EUR)',
			hint: 'What to call this, so you can tell it apart from your other methods.'
		},
		{
			name: 'text',
			label: 'Payment details',
			control: 'textarea',
			maxLength: OTHER_TEXT_MAX_LENGTH,
			placeholder: 'Whatever someone needs in order to pay you',
			hint: 'Written out for a person to read — this is copied as-is.'
		}
	],
	// Member-authored on both sides: the label is whatever the owner called it, and
	// the text is whatever they pasted. Wrap it wherever it reaches an agent
	// (ADR-0003 / ADR-0004) — formatting it does not make it trusted.
	format: ({ label, text }) => `${label} · ${text}`
});
