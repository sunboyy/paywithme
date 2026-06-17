CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"applies_to" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"value" bigint NOT NULL,
	"base" text NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_item_shares" (
	"item_id" text NOT NULL,
	"member_id" text NOT NULL,
	"amount_owed" bigint NOT NULL,
	"split_mode" text NOT NULL,
	"share_weight" integer,
	"raw_amount" bigint,
	CONSTRAINT "transaction_item_shares_item_id_member_id_pk" PRIMARY KEY("item_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_items" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"label" text NOT NULL,
	"amount" bigint NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_payers" (
	"transaction_id" text NOT NULL,
	"member_id" text NOT NULL,
	"amount_paid" bigint NOT NULL,
	"amount_paid_settlement" bigint NOT NULL,
	CONSTRAINT "transaction_payers_transaction_id_member_id_pk" PRIMARY KEY("transaction_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_shares" (
	"transaction_id" text NOT NULL,
	"member_id" text NOT NULL,
	"amount_owed" bigint NOT NULL,
	"share_weight" integer,
	"raw_amount" bigint,
	CONSTRAINT "transaction_shares_transaction_id_member_id_pk" PRIMARY KEY("transaction_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"category_id" text NOT NULL,
	"amount_total" bigint NOT NULL,
	"currency" text NOT NULL,
	"exchange_rate" numeric(18, 6) NOT NULL,
	"amount_total_settlement" bigint NOT NULL,
	"split_mode" text NOT NULL,
	"created_by" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"metadata" jsonb,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_charges" ADD CONSTRAINT "transaction_charges_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_item_shares" ADD CONSTRAINT "transaction_item_shares_item_id_transaction_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."transaction_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_item_shares" ADD CONSTRAINT "transaction_item_shares_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_payers" ADD CONSTRAINT "transaction_payers_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_payers" ADD CONSTRAINT "transaction_payers_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_shares" ADD CONSTRAINT "transaction_shares_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_shares" ADD CONSTRAINT "transaction_shares_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_charges_transaction_id_idx" ON "transaction_charges" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_item_shares_item_id_idx" ON "transaction_item_shares" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "transaction_items_transaction_id_idx" ON "transaction_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_payers_transaction_id_idx" ON "transaction_payers" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_shares_transaction_id_idx" ON "transaction_shares" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_group_id_occurred_at_idx" ON "transactions" USING btree ("group_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_group_id_occurred_at_idx" ON "audit_log" USING btree ("group_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log" USING btree ("entity_type","entity_id");