CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"last4" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"archived_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_usage" (
	"seq" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"provider_key_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"status" integer NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"provider_key_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"allowed_models" jsonb NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_provider_key_id_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."provider_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_keys_by_provider" ON "provider_keys" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "proxy_usage_by_run" ON "proxy_usage" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_keys_by_token_hash" ON "virtual_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "virtual_keys_by_run" ON "virtual_keys" USING btree ("run_id");