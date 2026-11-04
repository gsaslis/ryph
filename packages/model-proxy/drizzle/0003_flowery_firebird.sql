CREATE TABLE "custom_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_header" text NOT NULL,
	"auth_scheme" text,
	"extra_headers" jsonb NOT NULL,
	"models" jsonb NOT NULL,
	"archived_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
