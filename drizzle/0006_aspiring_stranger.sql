ALTER TABLE "categories" ADD COLUMN "sort_order" integer NOT NULL;--> statement-breakpoint
-- Seed the 14 fixed transaction categories (PLAN §7.3): 10 spending + 4 transfer.
-- Canonical source: src/lib/categories.ts (the parity unit test asserts this
-- INSERT matches it row-for-row). Ids are STABLE deterministic slugs (NOT random
-- UUIDs) so transactions.category_id resolves the same in every environment.
-- Idempotent via ON CONFLICT so re-applying — or a future name/icon/order tweak
-- in the constant + re-run — keeps the table in sync rather than failing on the
-- existing primary key. The ALTER above adds sort_order to the empty 4.2 table
-- just before this seed populates it.
INSERT INTO "categories" ("id", "name", "icon", "applies_to", "sort_order") VALUES
  ('spending-food-drink', 'Food & Drink', 'utensils', 'spending', 0),
  ('spending-groceries', 'Groceries', 'shopping-basket', 'spending', 1),
  ('spending-transportation', 'Transportation', 'car', 'spending', 2),
  ('spending-rent-housing', 'Rent / Housing', 'house', 'spending', 3),
  ('spending-utilities', 'Utilities', 'zap', 'spending', 4),
  ('spending-entertainment', 'Entertainment', 'clapperboard', 'spending', 5),
  ('spending-shopping', 'Shopping', 'shopping-bag', 'spending', 6),
  ('spending-travel', 'Travel', 'plane', 'spending', 7),
  ('spending-health', 'Health', 'heart-pulse', 'spending', 8),
  ('spending-other', 'Other', 'shapes', 'spending', 9),
  ('transfer-debt-settlement', 'Debt settlement', 'handshake', 'transfer', 0),
  ('transfer-cash', 'Cash', 'banknote', 'transfer', 1),
  ('transfer-bank-transfer', 'Bank transfer', 'landmark', 'transfer', 2),
  ('transfer-other', 'Other', 'shapes', 'transfer', 3)
ON CONFLICT ("id") DO UPDATE SET
  "name" = excluded."name",
  "icon" = excluded."icon",
  "applies_to" = excluded."applies_to",
  "sort_order" = excluded."sort_order";
