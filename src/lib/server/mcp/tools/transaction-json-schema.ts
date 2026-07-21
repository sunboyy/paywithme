/** Neutral JSON Schema fragments shared by create/update transaction tools. */
export const MONEY_PROPERTY = {
	type: 'string',
	pattern: '^\\d+(\\.\\d{1,4})?$',
	description: 'A non-negative decimal-string amount in the settlement currency.'
} as const;

export const MEMBER_ID_PROPERTY = { type: 'string', minLength: 1 } as const;
const equalBeneficiary = {
	type: 'object',
	properties: { memberId: MEMBER_ID_PROPERTY },
	required: ['memberId'],
	additionalProperties: false
} as const;
export const AMOUNT_BENEFICIARY_PROPERTY = {
	type: 'object',
	properties: { memberId: MEMBER_ID_PROPERTY, amount: MONEY_PROPERTY },
	required: ['memberId', 'amount'],
	additionalProperties: false
} as const;
export const SHARE_BENEFICIARY_PROPERTY = {
	type: 'object',
	properties: { memberId: MEMBER_ID_PROPERTY, shareWeight: { type: 'integer', minimum: 0 } },
	required: ['memberId', 'shareWeight'],
	additionalProperties: false
} as const;
const beneficiaryArray = (
	items:
		| typeof equalBeneficiary
		| typeof AMOUNT_BENEFICIARY_PROPERTY
		| typeof SHARE_BENEFICIARY_PROPERTY
) => ({ type: 'array', minItems: 1, items }) as const;
const item = (
	splitMode: 'equal' | 'amount' | 'share',
	beneficiaries:
		| typeof equalBeneficiary
		| typeof AMOUNT_BENEFICIARY_PROPERTY
		| typeof SHARE_BENEFICIARY_PROPERTY
) =>
	({
		type: 'object',
		properties: {
			label: { type: 'string', minLength: 1, maxLength: 200 },
			amount: MONEY_PROPERTY,
			splitMode: { const: splitMode },
			beneficiaries: beneficiaryArray(beneficiaries)
		},
		required: ['label', 'amount', 'splitMode', 'beneficiaries'],
		additionalProperties: false
	}) as const;
export const ITEM_PROPERTY = {
	oneOf: [
		item('equal', equalBeneficiary),
		item('amount', AMOUNT_BENEFICIARY_PROPERTY),
		item('share', SHARE_BENEFICIARY_PROPERTY)
	]
} as const;
export const CHARGE_PROPERTY = {
	oneOf: [
		{
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['service', 'vat', 'discount', 'tip'] },
				mode: { const: 'percent' },
				percent: {
					type: 'string',
					pattern: '^(?:(?:\\d{1,2}|0\\d{2})(?:\\.\\d{1,2})?|100(?:\\.0{1,2})?)$'
				},
				base: { type: 'string', enum: ['items_subtotal', 'running_total'] }
			},
			required: ['kind', 'mode', 'percent', 'base'],
			additionalProperties: false
		},
		{
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['service', 'vat', 'discount', 'tip'] },
				mode: { const: 'absolute' },
				amount: MONEY_PROPERTY,
				base: { type: 'string', enum: ['items_subtotal', 'running_total'] }
			},
			required: ['kind', 'mode', 'amount', 'base'],
			additionalProperties: false
		}
	]
} as const;
export const AMOUNT_BENEFICIARIES_PROPERTY = beneficiaryArray(AMOUNT_BENEFICIARY_PROPERTY);
export const SHARE_BENEFICIARIES_PROPERTY = beneficiaryArray(SHARE_BENEFICIARY_PROPERTY);
export const forbidProperties = (...fields: string[]) => ({
	not: { anyOf: fields.map((field) => ({ required: [field] })) }
});
