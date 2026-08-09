import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import CustomCurrencyFields from './CustomCurrencyFields.svelte';

// Client tests for the custom-currency field group (issue #62; PLAN §7.5.2, §10;
// ADR-0014).
//
// Three things here are load-bearing enough to test rather than eyeball:
//   - the LIVE PREVIEW goes through `formatAmount`, so it shows the ledger's own
//     code-prefixing rule for a custom currency — including for a symbol that
//     collides with a seeded one (`$`). A hand-rolled `${symbol}${amount}` would
//     have shown `$1,234.56` and lied.
//   - the preview tracks the decimal-places choice, which is how "permanent once
//     used" becomes a decision the user can actually make.
//   - once the row is REFERENCED, the code and decimal-places inputs are
//     READ-ONLY with a reason — the alternative (letting the save fail) is the
//     thing ADR-0014 decision 5 asks us not to do.

afterEach(cleanup);

const base = {
	idPrefix: 'create',
	displayCode: 'BEER',
	currencyName: 'Bottle of beer',
	symbol: '🍺',
	exponent: 0
};

describe('CustomCurrencyFields preview', () => {
	it('previews through formatAmount, code-prefixed, at the chosen decimal places', () => {
		const { getByTestId } = render(CustomCurrencyFields, { props: base });
		// exponent 0 → whole units, and a custom currency ALWAYS shows its code.
		expect(getByTestId('create-preview-value').textContent).toBe('BEER 🍺1,234');
	});

	it('code-prefixes a symbol that collides with a seeded one', () => {
		// `$` is USD's symbol. A member-authored symbol can be neither assumed
		// unique nor assumed not to be `$` (ADR-0014 decision 4), so the preview
		// must show `MYUSD $…`, never a bare `$…`.
		const { getByTestId } = render(CustomCurrencyFields, {
			props: { ...base, displayCode: 'MYUSD', symbol: '$', exponent: 2 }
		});
		const preview = getByTestId('create-preview-value').textContent;
		expect(preview).toBe('MYUSD $1,234.56');
		expect(preview?.startsWith('$')).toBe(false);
	});

	it('updates as the user types a new symbol', async () => {
		const { getByTestId, container } = render(CustomCurrencyFields, { props: base });
		const symbol = container.querySelector('#create-symbol') as HTMLInputElement;

		await fireEvent.input(symbol, { target: { value: 'B' } });

		expect(getByTestId('create-preview-value').textContent).toBe('BEER B1,234');
	});

	it('uppercases the typed code in the preview, as the schema will when storing it', async () => {
		const { getByTestId, container } = render(CustomCurrencyFields, { props: base });
		const code = container.querySelector('#create-displayCode') as HTMLInputElement;

		await fireEvent.input(code, { target: { value: 'pint' } });

		expect(getByTestId('create-preview-value').textContent).toBe('PINT 🍺1,234');
	});

	it('reflects the decimal-places choice', async () => {
		const { getByTestId, container } = render(CustomCurrencyFields, { props: base });
		const exponent = container.querySelector('#create-exponent') as HTMLSelectElement;

		await fireEvent.change(exponent, { target: { value: '3' } });

		expect(getByTestId('create-preview-value').textContent).toBe('BEER 🍺1,234.560');
	});
});

describe('CustomCurrencyFields permanence', () => {
	it('labels the code and decimal places as permanent BEFORE the currency is used', () => {
		const { container } = render(CustomCurrencyFields, { props: base });
		expect(container.textContent).toContain('Permanent once a transaction uses it');
		expect(container.querySelector('#create-exponent-hint')?.textContent).toContain('Permanent');
	});

	it('leaves every field editable while the currency is unreferenced', () => {
		const { container } = render(CustomCurrencyFields, { props: base });
		const code = container.querySelector('#create-displayCode') as HTMLInputElement;
		expect(code.readOnly).toBe(false);
		// A real <select>, so decimal places can still be changed.
		expect(container.querySelector('select#create-exponent')).not.toBeNull();
	});

	it('renders the code read-only with a reason once the currency is referenced', () => {
		const { container } = render(CustomCurrencyFields, {
			props: { ...base, idPrefix: 'edit-cur_beer', locked: true }
		});
		const code = container.querySelector('#edit-cur_beer-displayCode') as HTMLInputElement;

		expect(code.readOnly).toBe(true);
		expect(container.querySelector('#edit-cur_beer-displayCode-hint')?.textContent).toContain(
			'a transaction is already recorded in this currency'
		);
	});

	it('renders decimal places read-only once referenced, but still POSTS the stored value', () => {
		const { container, getByTestId } = render(CustomCurrencyFields, {
			props: { ...base, idPrefix: 'edit-cur_beer', exponent: 2, locked: true }
		});

		// No editable control…
		expect(container.querySelector('select[name="exponent"]')).toBeNull();
		expect(getByTestId('edit-cur_beer-exponent-readonly').textContent?.trim()).toBe('2');
		// …but the value still submits, so the service sees it UNCHANGED and the
		// name/symbol edit on the same form is allowed through.
		const hidden = container.querySelector('input[type="hidden"][name="exponent"]');
		expect(hidden?.getAttribute('value')).toBe('2');
	});

	it('shows a per-field error against the field it belongs to', () => {
		const { container } = render(CustomCurrencyFields, {
			props: {
				...base,
				errors: { displayCode: ['USD is already a supported currency'] }
			}
		});

		const error = container.querySelector('#create-displayCode-error');
		expect(error?.textContent).toContain('already a supported currency');
		expect(container.querySelector('#create-displayCode')?.getAttribute('aria-invalid')).toBe(
			'true'
		);
		expect(
			container.querySelector('#create-displayCode')?.getAttribute('aria-describedby')
		).toContain('create-displayCode-error');
		// Nothing bled onto the other fields.
		expect(container.querySelector('#create-name-error')).toBeNull();
		expect(container.querySelector('#create-symbol-error')).toBeNull();
	});
});
