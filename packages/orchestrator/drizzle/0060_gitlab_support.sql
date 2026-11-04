CREATE TABLE "gitlab_projects" (
	"connected_repo_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"instance" text NOT NULL,
	"hook_generation" integer NOT NULL,
	"last_hook_at" text,
	"last_merge_request_hook_at" text,
	"dropped_comment_hook_count" integer DEFAULT 0 NOT NULL,
	"dropped_other_hook_count" integer DEFAULT 0 NOT NULL,
	"last_dropped_hook_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "unproven_email" text;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD CONSTRAINT "gitlab_projects_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gitlab_projects_by_project" ON "gitlab_projects" USING btree ("project_id");