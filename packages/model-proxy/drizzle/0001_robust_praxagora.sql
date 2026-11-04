CREATE TABLE "platform_model_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_key_id" text NOT NULL,
	"provider" text NOT NULL,
	"allowed_models" jsonb NOT NULL,
	"model" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_model_policy" ADD CONSTRAINT "platform_model_policy_provider_key_id_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."provider_keys"("id") ON DELETE no action ON UPDATE no action;