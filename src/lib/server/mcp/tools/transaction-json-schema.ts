/** Neutral JSON Schema fragments shared by create/update transaction tools. */
export const MONEY_PROPERTY = {
	type: 'string',
	pattern: '^\\d+(\\.\\d{1,4})?$',
	description: 'A non-negative decimal-string amount in the settlement currency.'
} as const;

/**
 * How every write tool names a person (ADR-0015): the member's DISPLAY NAME, which is
 * unique among a group's active members, and which the server resolves itself by an
 * exact normalized match. Never a member id — an id in this field matches no name and
 * is a plain `validation_error`.
 */
export const MEMBER_NAME_PROPERTY = {
	type: 'string',
	minLength: 1,
	description:
		'A member DISPLAY NAME, copied exactly from `list_members` (the `displayName.value` ' +
		'string). Not a member id. The server matches it exactly against the active members ' +
		'of this group and rejects a name that matches none.'
} as const;
const equalBeneficiary = {
	type: 'object',
	properties: { memberName: MEMBER_NAME_PROPERTY },
	required: ['memberName'],
	additionalProperties: false
} as const;
export const AMOUNT_BENEFICIARY_PROPERTY = {
	type: 'object',
	properties: { memberName: MEMBER_NAME_PROPERTY, amount: MONEY_PROPERTY },
	required: ['memberName', 'amount'],
	additionalProperties: false
} as const;
export const SHARE_BENEFICIARY_PROPERTY = {
	type: 'object',
	properties: {
		memberName: MEMBER_NAME_PROPERTY,
		shareWeight: { type: 'integer', minimum: 0 }
	},
	required: ['memberName', 'shareWeight'],
	additionalProperties: false
} as const;
const beneficiaryArray = (
	items:
		typeof equalBeneficiary | typeof AMOUNT_BENEFICIARY_PROPERTY | typeof SHARE_BENEFICIARY_PROPERTY
) => ({ type: 'array', minItems: 1, items }) as const;
const item = (
	splitMode: 'equal' | 'amount' | 'share',
	beneficiaries:
		typeof equalBeneficiary | typeof AMOUNT_BENEFICIARY_PROPERTY | typeof SHARE_BENEFICIARY_PROPERTY
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
const forbidProperties = (...fields: string[]) => ({
	not: { anyOf: fields.map((field) => ({ required: [field] })) }
});

/**
 * The four mutually exclusive split shapes a transaction write accepts, each naming
 * the arguments it requires and forbidding the ones belonging to the other three.
 * `create_transaction` and `update_transaction` share it verbatim: an agent that has
 * learned to shape one write must not have to learn a second dialect for the other,
 * and a shape added here reaches both surfaces at once.
 */
export const SPLIT_SHAPE_ONE_OF = [
	{
		properties: { splitMode: { enum: ['equal'] } },
		required: ['amount', 'splitBetween'],
		...forbidProperties('beneficiaries', 'items', 'charges')
	},
	{
		properties: {
			splitMode: { const: 'amount' },
			beneficiaries: AMOUNT_BENEFICIARIES_PROPERTY
		},
		required: ['splitMode', 'amount', 'beneficiaries'],
		...forbidProperties('splitBetween', 'items', 'charges')
	},
	{
		properties: {
			splitMode: { const: 'share' },
			beneficiaries: SHARE_BENEFICIARIES_PROPERTY
		},
		required: ['splitMode', 'amount', 'beneficiaries'],
		...forbidProperties('splitBetween', 'items', 'charges')
	},
	{
		properties: { splitMode: { const: 'itemized' } },
		required: ['splitMode', 'items'],
		...forbidProperties('amount', 'splitBetween', 'beneficiaries')
	}
];
