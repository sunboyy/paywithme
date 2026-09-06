// The `th_promptpay` rail: a PromptPay proxy (PLAN §17.2).
//
// One entry beside `th_bank_account`, privileged nowhere (ADR-0016) — despite
// being the rail most Thai users will reach for first.

import { defineRail } from './types';
import {
	thPromptPayDetailsSchema,
	PROMPTPAY_PROXY_TYPE_LABELS
} from '$lib/schemas/receiving-method';

export const thPromptPayRail = defineRail({
	id: 'th_promptpay',
	label: 'PromptPay',
	detailsSchema: thPromptPayDetailsSchema,
	// Proxy type · value · holder name — the holder name last, for the same
	// name-check reason as the bank rail. The rail's own label ("PromptPay") is not
	// repeated here; the caller renders it around this line.
	format: ({ proxyType, proxyValue, accountHolderName }) =>
		[PROMPTPAY_PROXY_TYPE_LABELS[proxyType], proxyValue, accountHolderName].join(' · ')
});
