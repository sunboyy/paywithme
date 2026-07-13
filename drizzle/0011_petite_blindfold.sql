CREATE TABLE "api_key_class_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "api_key_class_rate_limit_key_unique" UNIQUE("key")
);
