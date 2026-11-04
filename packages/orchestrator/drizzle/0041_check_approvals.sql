CREATE TABLE "check_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"connected_repo_id" text NOT NULL,
	"change_request" text NOT NULL,
	"head_sha" text NOT NULL,
	"fetch_ref" text,
	"url" text,
	"author" text NOT NULL,
	"state" text NOT NULL,
	"comment_id" text,
	"comment_claimed_at" text,
	"approved_by_user_id" text,
	"approved_by_login" text,
	"approved_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_approvals" ADD CONSTRAINT "check_approvals_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "check_approvals_by_head" ON "check_approvals" USING btree ("connected_repo_id","change_request","head_sha");