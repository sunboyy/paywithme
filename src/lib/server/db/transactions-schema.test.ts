import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
	categories,
	transactions,
	transactionPayers,
	transactionShares,
	transactionItems,
	transactionItemShares,
	transactionCharges
} from './transactions-schema';
import * as schema from './schema';

// Import-level shape assertions for the ledger tables added in task 4.2
// (PLAN §9, §7.6, §8). No DB connection: we introspect the Drizzle table objects
// so an accidental rename, a wrong null/notNull, the wrong money column type, the
// reversed created_at/occurred_at semantics, or a dropped index/PK is caught at
// unit time. Mirrors `groups-schema.test.ts` / `currencies-schema.test.ts`.

describe('categories drizzle table', () => {
	it('maps to the `categories` SQL table', () => {
		expect(getTableName(categories)).toBe('categories');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(categories)).sort()).toEqual([
			'appliesTo',
			'icon',
			'id',
			'name',
			'sortOrder'
		]);
	});

	it('maps property keys to snake_case columns', () => {
		const c = getTableColumns(categories);
		expect(c.id.primary).toBe(true);
		expect(c.name.name).toBe('name');
		expect(c.name.notNull).toBe(true);
		expect(c.icon.name).toBe('icon');
		expect(c.icon.notNull).toBe(true);
		// applies_to ∈ {spending, transfer}; stored as text (validated in 4.4).
		expect(c.appliesTo.name).toBe('applies_to');
		expect(c.appliesTo.notNull).toBe(true);
		expect(c.appliesTo.columnType).toBe('PgText');
		// sort_order: display order within an applies_to set (PLAN §7.3).
		expect(c.sortOrder.name).toBe('sort_order');
		expect(c.sortOrder.notNull).toBe(true);
		expect(c.sortOrder.columnType).toBe('PgInteger');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).categories).toBe(categories);
	});
});

describe('transactions drizzle table', () => {
	it('maps to the `transactions` SQL table', () => {
		expect(getTableName(transactions)).toBe('transactions');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(transactions)).sort()).toEqual([
			'amountTotal',
			'amountTotalSettlement',
			'categoryId',
			'createdAt',
			'createdBy',
			'currency',
			'deletedAt',
			'exchangeRate',
			'groupId',
			'id',
			'occurredAt',
			'splitMode',
			'title',
			'type',
			'updatedAt'
		]);
	});

	it('stores money as bigint minor units', () => {
		const c = getTableColumns(transactions);
		// bigint(..., { mode: 'number' }) → PgBigInt53 (the 53-bit safe-integer mode).
		expect(c.amountTotal.name).toBe('amount_total');
		expect(c.amountTotal.columnType).toBe('PgBigInt53');
		expect(c.amountTotal.notNull).toBe(true);

		expect(c.amountTotalSettlement.name).toBe('amount_total_settlement');
		expect(c.amountTotalSettlement.columnType).toBe('PgBigInt53');
		expect(c.amountTotalSettlement.notNull).toBe(true);
	});

	it('stores exchange_rate as numeric(18,6), not a float or minor units', () => {
		const c = getTableColumns(transactions);
		expect(c.exchangeRate.name).toBe('exchange_rate');
		expect(c.exchangeRate.columnType).toBe('PgNumeric');
		expect(c.exchangeRate.notNull).toBe(true);
		// Precision/scale pinned by §7.6.
		const def = c.exchangeRate as unknown as { precision?: number; scale?: number };
		expect(def.precision).toBe(18);
		expect(def.scale).toBe(6);
	});

	it('wires the DELIBERATELY REVERSED created_at / occurred_at semantics (§7.1)', () => {
		const c = getTableColumns(transactions);

		// created_at = real-world date, editable, defaults to now.
		expect(c.createdAt.name).toBe('created_at');
		expect(c.createdAt.notNull).toBe(true);
		expect(c.createdAt.hasDefault).toBe(true);

		// occurred_at = immutable server insert time, defaults to now.
		expect(c.occurredAt.name).toBe('occurred_at');
		expect(c.occurredAt.notNull).toBe(true);
		expect(c.occurredAt.hasDefault).toBe(true);

		// updated_at = bumped on edit; defaults to now.
		expect(c.updatedAt.name).toBe('updated_at');
		expect(c.updatedAt.notNull).toBe(true);
		expect(c.updatedAt.hasDefault).toBe(true);

		// deleted_at = nullable soft-delete.
		expect(c.deletedAt.name).toBe('deleted_at');
		expect(c.deletedAt.notNull).toBe(false);
	});

	it('declares the required columns with the right nullability', () => {
		const c = getTableColumns(transactions);
		expect(c.id.primary).toBe(true);
		expect(c.groupId.name).toBe('group_id');
		expect(c.groupId.notNull).toBe(true);
		expect(c.type.name).toBe('type');
		expect(c.type.notNull).toBe(true);
		expect(c.title.notNull).toBe(true);
		expect(c.categoryId.name).toBe('category_id');
		expect(c.categoryId.notNull).toBe(true);
		expect(c.currency.name).toBe('currency');
		expect(c.currency.notNull).toBe(true);
		expect(c.splitMode.name).toBe('split_mode');
		expect(c.splitMode.notNull).toBe(true);
		// authorship is durable.
		expect(c.createdBy.name).toBe('created_by');
		expect(c.createdBy.notNull).toBe(true);
	});

	it('has FKs to groups, categories, currencies and user with correct onDelete', () => {
		const { foreignKeys } = getTableConfig(transactions);
		const byCol = (col: string) =>
			foreignKeys.find((fk) => fk.reference().columns.some((c) => c.name === col));

		// group_id → groups, cascade.
		expect(byCol('group_id')?.onDelete).toBe('cascade');
		// category_id → categories, default restrict ('no action', not cascade).
		expect(byCol('category_id')?.onDelete).not.toBe('cascade');
		// currency → currencies.code, default restrict.
		expect(byCol('currency')?.onDelete).not.toBe('cascade');
		// created_by → user, default restrict (durable authorship).
		expect(byCol('created_by')?.onDelete).not.toBe('cascade');
	});

	it('indexes (group_id, occurred_at) per PLAN §9', () => {
		const { indexes } = getTableConfig(transactions);
		const names = indexes.map((i) => i.config.name);
		expect(names).toContain('transactions_group_id_occurred_at_idx');
		const idx = indexes.find((i) => i.config.name === 'transactions_group_id_occurred_at_idx');
		const cols = (idx?.config.columns ?? []).map((col) => (col as { name?: string }).name);
		expect(cols).toEqual(['group_id', 'occurred_at']);
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).transactions).toBe(transactions);
	});
});

describe('transaction_payers drizzle table', () => {
	it('maps to the `transaction_payers` SQL table', () => {
		expect(getTableName(transactionPayers)).toBe('transaction_payers');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(transactionPayers)).sort()).toEqual([
			'amountPaid',
			'amountPaidSettlement',
			'memberId',
			'transactionId'
		]);
	});

	it('holds both txn-currency and settlement bigint money columns', () => {
		const c = getTableColumns(transactionPayers);
		expect(c.amountPaid.name).toBe('amount_paid');
		expect(c.amountPaid.columnType).toBe('PgBigInt53');
		expect(c.amountPaid.notNull).toBe(true);
		expect(c.amountPaidSettlement.name).toBe('amount_paid_settlement');
		expect(c.amountPaidSettlement.columnType).toBe('PgBigInt53');
		expect(c.amountPaidSettlement.notNull).toBe(true);
	});

	it('is keyed by composite PK (transaction_id, member_id) and indexed', () => {
		const { primaryKeys, indexes } = getTableConfig(transactionPayers);
		expect(primaryKeys).toHaveLength(1);
		expect(primaryKeys[0].columns.map((c) => c.name).sort()).toEqual([
			'member_id',
			'transaction_id'
		]);
		expect(indexes.map((i) => i.config.name)).toContain('transaction_payers_transaction_id_idx');
	});

	it('cascades from transaction and member', () => {
		const { foreignKeys } = getTableConfig(transactionPayers);
		for (const fk of foreignKeys) expect(fk.onDelete).toBe('cascade');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).transactionPayers).toBe(transactionPayers);
	});
});

describe('transaction_shares drizzle table', () => {
	it('maps to the `transaction_shares` SQL table', () => {
		expect(getTableName(transactionShares)).toBe('transaction_shares');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(transactionShares)).sort()).toEqual([
			'amountOwed',
			'memberId',
			'rawAmount',
			'shareWeight',
			'transactionId'
		]);
	});

	it('holds resolved settlement amount_owed (bigint) and nullable re-edit inputs', () => {
		const c = getTableColumns(transactionShares);
		expect(c.amountOwed.name).toBe('amount_owed');
		expect(c.amountOwed.columnType).toBe('PgBigInt53');
		expect(c.amountOwed.notNull).toBe(true);
		// optional inputs preserved for re-edit are nullable.
		expect(c.shareWeight.name).toBe('share_weight');
		expect(c.shareWeight.notNull).toBe(false);
		expect(c.rawAmount.name).toBe('raw_amount');
		expect(c.rawAmount.notNull).toBe(false);
		expect(c.rawAmount.columnType).toBe('PgBigInt53');
	});

	it('is keyed by composite PK (transaction_id, member_id) and indexed', () => {
		const { primaryKeys, indexes } = getTableConfig(transactionShares);
		expect(primaryKeys[0].columns.map((c) => c.name).sort()).toEqual([
			'member_id',
			'transaction_id'
		]);
		expect(indexes.map((i) => i.config.name)).toContain('transaction_shares_transaction_id_idx');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).transactionShares).toBe(transactionShares);
	});
});

describe('transaction_items drizzle table', () => {
	it('maps to the `transaction_items` SQL table', () => {
		expect(getTableName(transactionItems)).toBe('transaction_items');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(transactionItems)).sort()).toEqual([
			'amount',
			'id',
			'label',
			'sortOrder',
			'transactionId'
		]);
	});

	it('stores amount as bigint and sort_order as integer', () => {
		const c = getTableColumns(transactionItems);
		expect(c.id.primary).toBe(true);
		expect(c.amount.columnType).toBe('PgBigInt53');
		expect(c.amount.notNull).toBe(true);
		expect(c.sortOrder.name).toBe('sort_order');
		expect(c.sortOrder.columnType).toBe('PgInteger');
		expect(c.sortOrder.notNull).toBe(true);
	});

	it('indexes (transaction_id) per PLAN §9', () => {
		const { indexes } = getTableConfig(transactionItems);
		expect(indexes.map((i) => i.config.name)).toContain('transaction_items_transaction_id_idx');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).transactionItems).toBe(transactionItems);
	});
});

describe('transaction_item_shares drizzle table', () => {
	it('maps to the `transaction_item_shares` SQL table', () => {
		expect(getTableName(transactionItemShares)).toBe('transaction_item_shares');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(transactionItemShares)).sort()).toEqual([
			'amountOwed',
			'itemId',
			'memberId',
			'rawAmount',
			'shareWeight',
			'splitMode'
		]);
	});

	it('holds per-item resolved owed + per-item split inputs', () => {
		const c = getTableColumns(transactionItemShares);
		expect(c.amountOwed.columnType).toBe('PgBigInt53');
		expect(c.amountOwed.notNull).toBe(true);
		expect(c.splitMode.name).toBe('split_mode');
		expect(c.splitMode.notNull).toBe(true);
		expect(c.shareWeight.notNull).toBe(false);
		expect(c.rawAmount.notNull).toBe(false);
	});

	it('is keyed by composite PK (item_id, member_id) and indexed by item_id', () => {
		const { primaryKeys, indexes } = getTableConfig(transactionItemShares);
		expect(primaryKeys[0].columns.map((c) => c.name).sort()).toEqual(['item_id', 'member_id']);
		expect(indexes.map((i) => i.config.name)).toContain('transaction_item_shares_item_id_idx');
	});

	it('cascades from item and member', () => {
		const { foreignKeys } = getTableConfig(transactionItemShares);
		for (const fk of foreignKeys) expect(fk.onDelete).toBe('cascade');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).transactionItemShares).toBe(transactionItemShares);
	});
});

describe('transaction_charges drizzle table', () => {
	it('maps to the `transaction_charges` SQL table', () => {
		expect(getTableName(transactionCharges)).toBe('transaction_charges');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(transactionCharges)).sort()).toEqual([
			'base',
			'id',
			'kind',
			'mode',
			'sortOrder',
			'transactionId',
			'value'
		]);
	});

	it('stores kind/mode/base as text and value as bigint magnitude', () => {
		const c = getTableColumns(transactionCharges);
		expect(c.id.primary).toBe(true);
		expect(c.kind.columnType).toBe('PgText');
		expect(c.kind.notNull).toBe(true);
		expect(c.mode.columnType).toBe('PgText');
		expect(c.mode.notNull).toBe(true);
		expect(c.base.columnType).toBe('PgText');
		expect(c.base.notNull).toBe(true);
		// positive magnitude (bps or minor units); bigint.
		expect(c.value.columnType).toBe('PgBigInt53');
		expect(c.value.notNull).toBe(true);
		expect(c.sortOrder.name).toBe('sort_order');
		expect(c.sortOrder.columnType).toBe('PgInteger');
		expect(c.sortOrder.notNull).toBe(true);
	});

	it('indexes (transaction_id) per PLAN §9', () => {
		const { indexes } = getTableConfig(transactionCharges);
		expect(indexes.map((i) => i.config.name)).toContain('transaction_charges_transaction_id_idx');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).transactionCharges).toBe(transactionCharges);
	});
});
