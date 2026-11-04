CREATE TABLE "chatgpt_agent_host" (
	"id" text PRIMARY KEY NOT NULL,
	"ext_agent_host_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatgpt_sign_ins" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"nonce" text NOT NULL,
	"encrypted_verifier" text NOT NULL,
	"client_id" text,
	"key_id" text,
	"label" text,
	"redirect_uri" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"result_key_id" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_keys" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD COLUMN "plan_status" text;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD COLUMN "plan_limited_at" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chatgpt_sign_ins_by_state" ON "chatgpt_sign_ins" USING btree ("state");