CREATE TABLE "skill_bundles" (
	"digest" text PRIMARY KEY NOT NULL,
	"files" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"icons" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"disabled_catalogue" jsonb NOT NULL,
	"working_repo_skills" boolean NOT NULL,
	"org_repo_id" text,
	"org_branch" text,
	"org_current_sync_id" text,
	"org_checked_at" text,
	"org_checked_commit" text,
	"org_checked_started_at" text,
	"updated_at" text NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "skill_sync_entries" (
	"sync_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"digest" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"presentation" jsonb
);
--> statement-breakpoint
CREATE TABLE "skill_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"connected_repo_id" text NOT NULL,
	"branch" text NOT NULL,
	"trigger" text NOT NULL,
	"outcome" text NOT NULL,
	"failure" text,
	"rules_version" integer NOT NULL,
	"commit" text,
	"tree_id" text,
	"skill_count" integer NOT NULL,
	"warnings" jsonb NOT NULL,
	"error" text,
	"repeats" integer NOT NULL,
	"requested_by" text,
	"started_at" text NOT NULL,
	"finished_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "skill_policy" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "skills" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "skills_reported_at" text;--> statement-breakpoint
ALTER TABLE "skill_settings" ADD CONSTRAINT "skill_settings_org_repo_id_connected_repos_id_fk" FOREIGN KEY ("org_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_settings" ADD CONSTRAINT "skill_settings_org_current_sync_id_skill_syncs_id_fk" FOREIGN KEY ("org_current_sync_id") REFERENCES "public"."skill_syncs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sync_entries" ADD CONSTRAINT "skill_sync_entries_sync_id_skill_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."skill_syncs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sync_entries" ADD CONSTRAINT "skill_sync_entries_digest_skill_bundles_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."skill_bundles"("digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_syncs" ADD CONSTRAINT "skill_syncs_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sync_entries_entry" ON "skill_sync_entries" USING btree ("sync_id","name");--> statement-breakpoint
CREATE INDEX "skill_sync_entries_by_name" ON "skill_sync_entries" USING btree ("name","sync_id");--> statement-breakpoint
CREATE INDEX "skill_syncs_by_repo" ON "skill_syncs" USING btree ("connected_repo_id","finished_at");