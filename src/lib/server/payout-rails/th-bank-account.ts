// The `th_bank_account` rail: a Thai bank transfer (PLAN §17.2).
//
// The bank list and the field rules live with the schema in
// `$lib/schemas/receiving-method.ts` (project convention: shared Zod schemas in
// `lib/schemas/`) — a schema that validates `bank` has to know the shipped values.
// Nothing outside this rail reads either.

import { defineRail } from './types';
import { thBankAccountDetailsSchema, thaiBankName } from '$lib/schemas/receiving-method';

export const thBankAccountRail = defineRail({
	id: 'th_bank_account',
	label: 'Thai bank account',
	detailsSchema: thBankAccountDetailsSchema,
	// Bank · account number · holder name. The holder name is LAST and always
	// present: it is what the payer compares against their banking app (PLAN §17.2).
	// `thaiBankName` cannot miss here — the schema already rejected any id outside
	// the shipped list — but a stored id whose entry was (wrongly) removed would
	// render as itself rather than as `undefined`.
	format: ({ bank, accountNumber, accountHolderName }) =>
		[thaiBankName(bank) ?? bank, accountNumber, accountHolderName].join(' · ')
});
