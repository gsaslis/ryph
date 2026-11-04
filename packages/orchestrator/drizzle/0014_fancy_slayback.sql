CREATE TABLE "auth_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"allow_open_registration" boolean DEFAULT false NOT NULL,
	"allow_forge_org_join" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"login" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email" text,
	"role" text NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" text NOT NULL,
	"created_by" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_time_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_hash" text NOT NULL,
	"user_id" text,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb NOT NULL,
	"name" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"device_type" text,
	"created_at" text NOT NULL,
	"last_used_at" text
);
--> statement-breakpoint
INSERT INTO "external_identities" ("id", "user_id", "provider", "provider_account_id", "login", "email", "email_verified", "created_at", "updated_at")
SELECT 'i-' || "user_id", "user_id", 'github', 'login:' || "github_login", "github_login", NULL, false, "created_at", "updated_at"
FROM "github_user_identities";--> statement-breakpoint
ALTER TABLE "github_user_identities" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "github_user_identities" CASCADE;--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "last_used_at" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" text;--> statement-breakpoint
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_requested_at" text;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_by_account" ON "external_identities" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_by_user_provider" ON "external_identities" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "external_identities_by_login" ON "external_identities" USING btree ("provider","login");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_by_token_hash" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "one_time_tokens_by_token_hash" ON "one_time_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "one_time_tokens_by_user" ON "one_time_tokens" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "passkeys_by_user" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;