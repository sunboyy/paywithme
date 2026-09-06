// The `th_bank_account` rail: a Thai bank transfer (PLAN §17.2).
//
// The bank list and the field rules live with the schema in
// `$lib/schemas/receiving-method.ts` (project convention: shared Zod schemas in
// `lib/schemas/`) — a schema that validates `bank` has to know the shipped values.
// Nothing outside this rail reads either.

import { defineRail } from './types';
import {
	ACCOUNT_HOLDER_NAME_MAX_LENGTH,
	ACCOUNT_NUMBER_MAX_DIGITS,
	THAI_BANKS,
	thBankAccountDetailsSchema,
	thaiBankName
} from '$lib/schemas/receiving-method';

export const thBankAccountRail = defineRail({
	id: 'th_bank_account',
	label: 'Thai bank account',
	detailsSchema: thBankAccountDetailsSchema,
	// The editor renders these and nothing else (issue #85) — the shipped bank list
	// reaches the form straight from the same constant the schema validates against,
	// so a bank can never be offered that `bank` would reject.
	fields: [
		{
			name: 'bank',
			label: 'Bank',
			control: 'select',
			options: THAI_BANKS.map((bank) => ({ value: bank.id, label: bank.name }))
		},
		{
			name: 'accountNumber',
			label: 'Account number',
			control: 'text',
			inputMode: 'numeric',
			maxLength: ACCOUNT_NUMBER_MAX_DIGITS,
			placeholder: 'Digits only'
		},
		{
			name: 'accountHolderName',
			label: 'Account holder name',
			control: 'text',
			maxLength: ACCOUNT_HOLDER_NAME_MAX_LENGTH,
			// The load-bearing field (PLAN §17.2): it is what the payer compares
			// against their banking app, so the hint says where the value comes from —
			// the bank's record — rather than describing a format.
			hint: 'Exactly as your bank has it. People pay you by checking this name.'
		}
	],
	// Bank · account number · holder name. The holder name is LAST and always
	// present: it is what the payer compares against their banking app (PLAN §17.2).
	// `thaiBankName` cannot miss here — the schema already rejected any id outside
	// the shipped list — but a stored id whose entry was (wrongly) removed would
	// render as itself rather than as `undefined`.
	format: ({ bank, accountNumber, accountHolderName }) =>
		[thaiBankName(bank) ?? bank, accountNumber, accountHolderName].join(' · ')
});
