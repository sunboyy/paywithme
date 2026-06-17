// Canonical category data — the SINGLE SOURCE OF TRUTH for the app's fixed
// transaction categories (PLAN §7.3). Shared by client and server: the UI renders
// each category's lucide icon by name and lists categories filtered by
// `appliesTo` in `sortOrder`; the seed migration reads the SAME rows. This is
// *data only* — no UI, no icon component imports (the `icon` string is a lucide
// icon name resolved to a glyph in the UI layer).
//
// Mirrors `src/lib/money/currencies.ts`: everything downstream derives from
// `CATEGORIES` so the representations can never drift:
//   - the Drizzle `categories` table + its idempotent seed migration
//     (`drizzle/0006_*.sql`) seed exactly these rows;
//   - `transactions.category_id` (a NOT-NULL FK → `categories.id`) references
//     these ids, so the ids MUST be STABLE across every environment — they are
//     deterministic slugs, NOT random UUIDs, and the seed upserts on id.
//   - a parity unit test (`src/lib/categories.test.ts`) asserts the seed INSERT
//     matches this constant row-for-row.
//
// ── id convention ─────────────────────────────────────────────────────────────
// Each id is a stable slug namespaced by `appliesTo`: `${appliesTo}-${slug}`,
// e.g. `spending-food-drink`, `transfer-debt-settlement`. The namespace keeps the
// two "Other" rows (one spending, one transfer — same name, same `shapes` icon)
// distinct: `spending-other` vs `transfer-other`.
//
// ── sortOrder convention ──────────────────────────────────────────────────────
// `sortOrder` is 0-based and assigned independently within each `appliesTo` set,
// matching the PLAN §7.3 table order: spending 0..9, transfer 0..3. The UI shows
// only the categories whose `appliesTo` matches the selected transaction type
// (§7.3), so the two sequences never interleave.

/** One fixed transaction category (PLAN §7.3). */
export interface Category {
	/**
	 * Stable, deterministic slug id, `${appliesTo}-${slug}`, e.g.
	 * `'spending-food-drink'`. Referenced by `transactions.category_id`; NEVER a
	 * random UUID (ids must be identical across environments for the seed to be
	 * idempotent and FKs to resolve).
	 */
	readonly id: string;
	/** Human-readable display name, e.g. `'Food & Drink'`. */
	readonly name: string;
	/** lucide icon name (kebab-case), e.g. `'utensils'`. Resolved to a glyph in the UI. */
	readonly icon: string;
	/** Which transaction `type` may use this category: `'spending'` | `'transfer'`. */
	readonly appliesTo: 'spending' | 'transfer';
	/** 0-based display order within this category's `appliesTo` set (PLAN §7.3 table order). */
	readonly sortOrder: number;
}

/**
 * The canonical, ordered list of all 14 fixed categories (PLAN §7.3): 10
 * spending + 4 transfer. Order matches the PLAN tables. `as const` makes every
 * field a literal so ids/icons can't be mistyped downstream.
 */
export const CATEGORIES = [
	// ── spending (sortOrder 0..9) ──
	{
		id: 'spending-food-drink',
		name: 'Food & Drink',
		icon: 'utensils',
		appliesTo: 'spending',
		sortOrder: 0
	},
	{
		id: 'spending-groceries',
		name: 'Groceries',
		icon: 'shopping-basket',
		appliesTo: 'spending',
		sortOrder: 1
	},
	{
		id: 'spending-transportation',
		name: 'Transportation',
		icon: 'car',
		appliesTo: 'spending',
		sortOrder: 2
	},
	{
		id: 'spending-rent-housing',
		name: 'Rent / Housing',
		icon: 'house',
		appliesTo: 'spending',
		sortOrder: 3
	},
	{ id: 'spending-utilities', name: 'Utilities', icon: 'zap', appliesTo: 'spending', sortOrder: 4 },
	{
		id: 'spending-entertainment',
		name: 'Entertainment',
		icon: 'clapperboard',
		appliesTo: 'spending',
		sortOrder: 5
	},
	{
		id: 'spending-shopping',
		name: 'Shopping',
		icon: 'shopping-bag',
		appliesTo: 'spending',
		sortOrder: 6
	},
	{ id: 'spending-travel', name: 'Travel', icon: 'plane', appliesTo: 'spending', sortOrder: 7 },
	{
		id: 'spending-health',
		name: 'Health',
		icon: 'heart-pulse',
		appliesTo: 'spending',
		sortOrder: 8
	},
	{ id: 'spending-other', name: 'Other', icon: 'shapes', appliesTo: 'spending', sortOrder: 9 },
	// ── transfer (sortOrder 0..3) ──
	{
		id: 'transfer-debt-settlement',
		name: 'Debt settlement',
		icon: 'handshake',
		appliesTo: 'transfer',
		sortOrder: 0
	},
	{ id: 'transfer-cash', name: 'Cash', icon: 'banknote', appliesTo: 'transfer', sortOrder: 1 },
	{
		id: 'transfer-bank-transfer',
		name: 'Bank transfer',
		icon: 'landmark',
		appliesTo: 'transfer',
		sortOrder: 2
	},
	{ id: 'transfer-other', name: 'Other', icon: 'shapes', appliesTo: 'transfer', sortOrder: 3 }
] as const satisfies readonly Category[];

/** Union of every category id, e.g. `'spending-food-drink' | …`. Derived from `CATEGORIES`. */
export type CategoryId = (typeof CATEGORIES)[number]['id'];

/**
 * O(1) lookup map (id → Category). Built once at module load; backs
 * `getCategory`.
 */
const CATEGORY_BY_ID: ReadonlyMap<string, Category> = new Map(CATEGORIES.map((c) => [c.id, c]));

/**
 * Resolve a category by its (stable slug) id. Pure and synchronous; returns the
 * matching {@link Category} or `undefined` for an unknown id.
 */
export function getCategory(id: string): Category | undefined {
	return CATEGORY_BY_ID.get(id);
}

/**
 * Categories that apply to a given transaction type, sorted by `sortOrder` — the
 * exact list the transaction form renders for the selected type (PLAN §7.3).
 */
export function categoriesFor(appliesTo: Category['appliesTo']): readonly Category[] {
	return CATEGORIES.filter((c) => c.appliesTo === appliesTo).sort(
		(a, b) => a.sortOrder - b.sortOrder
	);
}
