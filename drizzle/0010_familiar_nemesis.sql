CREATE TABLE "idempotency_key" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "idempotency_key_key_id_key_unq" UNIQUE("key_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_key_id_api_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;