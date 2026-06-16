CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"exponent" integer NOT NULL,
	"symbol" text NOT NULL
);
--> statement-breakpoint
-- Seed the 29 supported fiat currencies (PLAN §7.5.1 / #19). Canonical source:
-- src/lib/money/currencies.ts (the parity unit test asserts this INSERT matches
-- it row-for-row). Idempotent via ON CONFLICT so re-applying — or a future
-- symbol/name tweak in the constant + re-run — keeps the table in sync rather
-- than failing on the existing primary key.
INSERT INTO "currencies" ("code", "name", "exponent", "symbol") VALUES
  ('CNY', 'Chinese Yuan', 2, 'CN¥'),
  ('USD', 'US Dollar', 2, '$'),
  ('EUR', 'Euro', 2, '€'),
  ('JPY', 'Japanese Yen', 0, '¥'),
  ('GBP', 'Pound Sterling', 2, '£'),
  ('KRW', 'South Korean Won', 0, '₩'),
  ('HKD', 'Hong Kong Dollar', 2, 'HK$'),
  ('TWD', 'New Taiwan Dollar', 2, 'NT$'),
  ('CAD', 'Canadian Dollar', 2, 'CA$'),
  ('RUB', 'Russian Ruble', 2, '₽'),
  ('BRL', 'Brazilian Real', 2, 'R$'),
  ('CHF', 'Swiss Franc', 2, 'CHF'),
  ('MXN', 'Mexican Peso', 2, 'MX$'),
  ('INR', 'Indian Rupee', 2, '₹'),
  ('SAR', 'Saudi Riyal', 2, 'SAR'),
  ('AED', 'UAE Dirham', 2, 'AED'),
  ('PLN', 'Polish Zloty', 2, 'zł'),
  ('THB', 'Thai Baht', 2, '฿'),
  ('SGD', 'Singapore Dollar', 2, 'S$'),
  ('VND', 'Vietnamese Dong', 0, '₫'),
  ('MYR', 'Malaysian Ringgit', 2, 'RM'),
  ('TRY', 'Turkish Lira', 2, '₺'),
  ('IDR', 'Indonesian Rupiah', 2, 'Rp'),
  ('SEK', 'Swedish Krona', 2, 'kr'),
  ('ILS', 'Israeli New Shekel', 2, '₪'),
  ('NOK', 'Norwegian Krone', 2, 'kr'),
  ('CZK', 'Czech Koruna', 2, 'Kč'),
  ('PHP', 'Philippine Peso', 2, '₱'),
  ('ZAR', 'South African Rand', 2, 'R')
ON CONFLICT ("code") DO UPDATE SET
  "name" = excluded."name",
  "exponent" = excluded."exponent",
  "symbol" = excluded."symbol";
