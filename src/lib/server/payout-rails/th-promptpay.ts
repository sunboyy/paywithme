// The `th_promptpay` rail: a PromptPay proxy (PLAN §17.2).
//
// One entry beside `th_bank_account`, privileged nowhere (ADR-0016) — despite
// being the rail most Thai users will reach for first.
//
// It is the only rail that can produce a QR (issue #88; ADR-0017), which is a
// FACT ABOUT THAILAND'S PAYMENT NETWORK rather than a promotion: the #82 spike
// found that a bank + account number encodes to nothing any Thai banking app will
// read, and `other` is free text with nothing to encode. The payload lives in
// `./thai-qr.ts`, imported here and nowhere else.

import { defineRail } from './types';
import { THAI_QR_CURRENCY, encodeThaiQrPayload } from './thai-qr';
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
			placeholder: 'Digits only',
			// The proxy the payer enters — the copy affordance goes here (issue #86).
			payerRole: 'copy'
		},
		{
			name: 'accountHolderName',
			label: 'Account holder name',
			control: 'text',
			maxLength: ACCOUNT_HOLDER_NAME_MAX_LENGTH,
			hint: 'Exactly as your bank has it. People pay you by checking this name.',
			payerRole: 'name-check'
		}
	],
	// Proxy type · value · holder name — the holder name last, for the same
	// name-check reason as the bank rail. The rail's own label ("PromptPay") is not
	// repeated here; the caller renders it around this line.
	format: ({ proxyType, proxyValue, accountHolderName }) =>
		[PROMPTPAY_PROXY_TYPE_LABELS[proxyType], proxyValue, accountHolderName].join(' · '),
	// THB ONLY, and this is correctness rather than polish: the payload hard-codes
	// ISO 4217 `764`, so a transfer in any other currency must yield NO code at all.
	// A QR carrying "45.00" from a euro balance is one a banking app reads as ฿45,
	// and the payer would have no way to see that from the screen.
	//
	// The holder name is not in the payload and could not be: a QR proves nothing
	// about who owns the account, so the name check (PLAN §17.2) is unchanged by
	// this and stays on screen beside the code.
	encodeQr: ({ proxyType, proxyValue }, { amount, currency }) =>
		currency === THAI_QR_CURRENCY ? encodeThaiQrPayload({ proxyType, proxyValue, amount }) : null
});
