import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ReceivingMethodFields from './ReceivingMethodFields.svelte';
import type { RailField } from '$lib/payout-rail-fields';

// Client tests for the receiving-method field group (issue #85; PLAN §17.2,
// §17.4; ADR-0016).
//
// The claim worth testing is the one the whole feature rests on: THIS COMPONENT
// DOES NOT KNOW ANY RAIL. So the fixture below is a rail that does not exist —
// a made-up country with a select, a text field and a textarea. If a rail id ever
// leaked into the component, this spec would be the thing that fails.
//
// The SHIPPED rails are covered from the other side: `payout-rails/index.test.ts`
// asserts every entry's descriptors are ones this component can render (a known
// control, options exactly where a select needs them).

afterEach(cleanup);

/** A rail from a country this app has never heard of. */
const INVENTED_FIELDS: RailField[] = [
	{
		name: 'iban',
		label: 'IBAN',
		control: 'text',
		maxLength: 34,
		placeholder: 'DE89…',
		hint: 'From your bank statement.'
	},
	{
		name: 'scheme',
		label: 'Scheme',
		control: 'select',
		options: [
			{ value: 'sepa', label: 'SEPA' },
			{ value: 'swift', label: 'SWIFT' }
		]
	},
	{ name: 'notes', label: 'Notes', control: 'textarea', maxLength: 200 }
];

const VALUES = { iban: 'DE89370400440532013000', scheme: 'swift', notes: 'Any branch' };

function renderInvented(errors: Record<string, string[] | undefined> = {}) {
	return render(ReceivingMethodFields, {
		props: { idPrefix: 'rm', fields: INVENTED_FIELDS, values: VALUES, errors }
	});
}

describe('rendering a rail the component has never heard of', () => {
	it('renders one labelled, named control per descriptor', () => {
		const { container } = renderInvented();

		for (const field of INVENTED_FIELDS) {
			const input = container.querySelector(`#rm-${field.name}`) as HTMLElement | null;
			expect(input, field.name).not.toBeNull();
			expect(input!.getAttribute('name'), field.name).toBe(field.name);
			// A real <label for>, so the field is announced and tappable by its text.
			const label = container.querySelector(`label[for="rm-${field.name}"]`);
			expect(label?.textContent?.trim(), field.name).toBe(field.label);
		}
	});

	it('picks the control the descriptor asks for — and a NATIVE select, so it posts without JS', () => {
		const { container } = renderInvented();

		expect(container.querySelector('#rm-iban')?.tagName).toBe('INPUT');
		expect(container.querySelector('#rm-notes')?.tagName).toBe('TEXTAREA');

		const select = container.querySelector('#rm-scheme') as HTMLSelectElement;
		expect(select.tagName).toBe('SELECT');
		expect([...select.options].map((option) => option.value)).toEqual(['sepa', 'swift']);
	});

	it('prefills every control from `values`, including the select', () => {
		const { container } = renderInvented();

		expect((container.querySelector('#rm-iban') as HTMLInputElement).value).toBe(VALUES.iban);
		expect((container.querySelector('#rm-notes') as HTMLTextAreaElement).value).toBe(VALUES.notes);
		expect((container.querySelector('#rm-scheme') as HTMLSelectElement).value).toBe('swift');
	});

	it('leaves a blank select on its first option, so an untouched add form still posts one', () => {
		// Svelte clears the selection when the value matches no option, which on the
		// ADD form (every value `''`) left the select empty and posting nothing — the
		// server then answered "Select a …" for a field the user was never shown as
		// unset. The server-rendered form has always fallen back to the first option.
		const { container } = render(ReceivingMethodFields, {
			props: {
				idPrefix: 'rm',
				fields: INVENTED_FIELDS,
				values: { iban: '', scheme: '', notes: '' }
			}
		});

		const select = container.querySelector('#rm-scheme') as HTMLSelectElement;
		expect(select.selectedIndex).toBe(0);
		expect(select.value).toBe('sepa');
	});

	it('passes the schema’s own length cap through, and nothing else', () => {
		const { container } = renderInvented();

		expect(container.querySelector('#rm-iban')?.getAttribute('maxlength')).toBe('34');
		// No `required`, `pattern` or `minlength`: validation is the rail's schema's
		// job and its messages come back from the server (PLAN §17.2).
		for (const attribute of ['required', 'pattern', 'minlength']) {
			expect(container.querySelector(`#rm-iban`)?.hasAttribute(attribute), attribute).toBe(false);
		}
	});

	it('shows a field’s error verbatim and wires it to the input', () => {
		const { container, getByText } = renderInvented({ iban: ['That IBAN is not valid'] });

		const input = container.querySelector('#rm-iban') as HTMLInputElement;
		expect(getByText('That IBAN is not valid')).toBeTruthy();
		expect(input.getAttribute('aria-invalid')).toBe('true');
		// Both the hint and the error are announced, in that order.
		expect(input.getAttribute('aria-describedby')).toBe('rm-iban-hint rm-iban-error');
	});

	it('marks only the field that failed', () => {
		const { container } = renderInvented({ iban: ['nope'] });

		expect(container.querySelector('#rm-scheme')?.getAttribute('aria-invalid')).toBeNull();
	});
});
