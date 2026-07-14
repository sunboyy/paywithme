// `list_currencies` — the supported-currency table (issue #29; PLAN §7.5.1).
//
// The agent's version of `/api/v1/currencies`, and a different thing on purpose
// (ADR-0006). REST serves `exponent` so a program can turn 24000 into "240.00". The
// agent must never do that arithmetic at all (ADR-0004): it passes and reads DECIMAL
// STRINGS, and `decimalPlaces` is here only so it can see how many places a currency
// ACCEPTS — "240.005" in THB is rejected, not rounded, and in JPY there are no decimal
// places to give.
//
// Static, app-defined reference data: nothing here is member-authored, so nothing here
// is wrapped. Still an authenticated, rate-limited tool like any other.

import { z } from 'zod';
import { toolSuccess } from '../errors';
import { toCurrencyViews, CURRENCIES_NOTE } from '../view';
import type { McpTool } from '../types';
import { NO_INPUT_SCHEMA } from './args';

const listCurrenciesArgs = z.strictObject({});

export const listCurrenciesTool: McpTool<z.infer<typeof listCurrenciesArgs>> = {
	scope: 'read',
	rateLimitClass: 'read',
	args: listCurrenciesArgs,
	definition: {
		name: 'list_currencies',
		title: 'List supported currencies',
		description:
			'List every currency paywithme supports, with its symbol and how many decimal ' +
			'places it accepts. Amounts in this API are always decimal strings in ordinary ' +
			'units ("240.00" is two hundred and forty) — you never multiply by 100 and you ' +
			'never convert between currencies yourself. Use this to check that a currency the ' +
			'user named is supported, and how many decimals it takes.',
		inputSchema: NO_INPUT_SCHEMA,
		annotations: {
			title: 'List supported currencies',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async () => toolSuccess({ currencies: toCurrencyViews(), _note: CURRENCIES_NOTE })
};
