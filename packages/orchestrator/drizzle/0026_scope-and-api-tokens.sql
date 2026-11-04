CREATE TABLE "repo_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connected_repo_id" text NOT NULL,
	"writable" boolean NOT NULL,
	"checked_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"caps" jsonb NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"revoked_at" text
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_access_by_user_repo" ON "repo_access" USING btree ("user_id","connected_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_by_token_hash" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_by_user" ON "api_tokens" USING btree ("user_id","created_at");