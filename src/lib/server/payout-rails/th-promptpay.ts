// The `th_promptpay` rail: a PromptPay proxy (PLAN §17.2).
//
// One entry beside `th_bank_account`, privileged nowhere (ADR-0016) — despite
// being the rail most Thai users will reach for first.

import { defineRail } from './types';
import {
	thPromptPayDetailsSchema,
	ACCOUNT_HOLDER_NAME_MAX_LENGTH,
	PROMPTPAY_PROXY_TYPES,
	PROMPTPAY_PROXY_TYPE_LABELS,
	PROXY_VALUE_MAX_DIGITS
} from '$lib/schemas/receiving-method';

export const thPromptPayRail = defineRail({
	id: 'th_promptpay',
	label: 'PromptPay',
	detailsSchema: thPromptPayDetailsSchema,
	// Rendered by the editor (issue #85). The proxy-type options come from the same
	// constant the schema's enum is built from, and are labelled by the same map the
	// formatter uses, so picker and stored line can never name a type differently.
	fields: [
		{
			name: 'proxyType',
			label: 'PromptPay type',
			control: 'select',
			options: PROMPTPAY_PROXY_TYPES.map((type) => ({
				value: type,
				label: PROMPTPAY_PROXY_TYPE_LABELS[type]
			}))
		},
		{
			name: 'proxyValue',
			label: 'PromptPay number',
			control: 'text',
			inputMode: 'numeric',
			maxLength: PROXY_VALUE_MAX_DIGITS,
			placeholder: 'Digits only'
		},
		{
			name: 'accountHolderName',
			label: 'Account holder name',
			control: 'text',
			maxLength: ACCOUNT_HOLDER_NAME_MAX_LENGTH,
			hint: 'Exactly as your bank has it. People pay you by checking this name.'
		}
	],
	// Proxy type · value · holder name — the holder name last, for the same
	// name-check reason as the bank rail. The rail's own label ("PromptPay") is not
	// repeated here; the caller renders it around this line.
	format: ({ proxyType, proxyValue, accountHolderName }) =>
		[PROMPTPAY_PROXY_TYPE_LABELS[proxyType], proxyValue, accountHolderName].join(' · ')
});
