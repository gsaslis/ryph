CREATE TABLE "build_git_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"ref" text NOT NULL,
	"default_branch" boolean NOT NULL,
	"commits" jsonb NOT NULL,
	"ryph_tree" text,
	"base_digest" text NOT NULL,
	"harness_digest" text NOT NULL,
	"image" text,
	"baked_image" text,
	"status" text NOT NULL,
	"toolchains" jsonb NOT NULL,
	"size_bytes" bigint,
	"trigger" text NOT NULL,
	"plan" jsonb NOT NULL,
	"log_ref" text,
	"log_tail" text,
	"failure" text,
	"started_at" text,
	"finished_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_builds" (
	"patch_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"environment_id" text,
	"branch" text,
	"note" text,
	"checked_at" text NOT NULL,
	"claimed_until" text,
	"reported_at" text
);
--> statement-breakpoint
ALTER TABLE "connected_repos" ADD COLUMN "size_class" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "environment_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "environment" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "environment_wait" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "size_class" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "environment_repo_id" text;--> statement-breakpoint
ALTER TABLE "build_git_keys" ADD CONSTRAINT "build_git_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_builds" ADD CONSTRAINT "patch_builds_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_builds" ADD CONSTRAINT "patch_builds_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_builds" ADD CONSTRAINT "patch_builds_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_git_keys_by_token_hash" ON "build_git_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "build_git_keys_by_environment" ON "build_git_keys" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "environments_by_subject" ON "environments" USING btree ("subject_kind","subject_id","ref","created_at");--> statement-breakpoint
CREATE INDEX "environments_by_status" ON "environments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "patch_builds_by_run" ON "patch_builds" USING btree ("run_id","checked_at");--> statement-breakpoint
CREATE INDEX "patch_builds_by_environment" ON "patch_builds" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "patch_builds_by_reported" ON "patch_builds" USING btree ("reported_at");--> statement-breakpoint
CREATE INDEX "runs_by_environment" ON "runs" USING btree ("environment_id");