CREATE TABLE "check_forge_reports" (
	"patch_id" text PRIMARY KEY NOT NULL,
	"connected_repo_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"suite_id" text,
	"reported_fingerprint" text,
	"attempts" integer NOT NULL,
	"next_attempt_at" text,
	"last_error" text,
	"disabled_until" text,
	"revision" integer NOT NULL,
	"open_generations" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_git_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"suite_id" text NOT NULL,
	"generation" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"suite_id" text,
	"rerun_of" text,
	"connected_repo_id" text NOT NULL,
	"commit" text NOT NULL,
	"run_id" text,
	"patch_id" text,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"note" text,
	"source" jsonb NOT NULL,
	"checks_ref" text NOT NULL,
	"reported_generation" integer,
	"attempts" integer NOT NULL,
	"next_attempt_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_results" (
	"suite_id" text NOT NULL,
	"generation" integer NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"exit_code" integer,
	"started_at" text,
	"finished_at" text,
	"log_key" text,
	"log_tail" text,
	"watched_changed" boolean,
	"forge_ref" text
);
--> statement-breakpoint
CREATE TABLE "check_suites" (
	"id" text PRIMARY KEY NOT NULL,
	"connected_repo_id" text NOT NULL,
	"commit" text NOT NULL,
	"checks_ref" text NOT NULL,
	"checks_commit" text NOT NULL,
	"checks_blob" text NOT NULL,
	"checks_path" text NOT NULL,
	"definition" jsonb NOT NULL,
	"environment_key" text NOT NULL,
	"inputs_key" text NOT NULL,
	"network_scope" jsonb NOT NULL,
	"environment_id" text,
	"image" text,
	"services" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"state" text NOT NULL,
	"generation" integer NOT NULL,
	"reason" text,
	"attempts" integer NOT NULL,
	"ryph_changed" boolean,
	"lease_until" text,
	"waiting_since" text,
	"next_attempt_at" text,
	"launched_at" text,
	"finished_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD CONSTRAINT "check_forge_reports_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD CONSTRAINT "check_forge_reports_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD CONSTRAINT "check_forge_reports_suite_id_check_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."check_suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_git_keys" ADD CONSTRAINT "check_git_keys_suite_id_check_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."check_suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_requests" ADD CONSTRAINT "check_requests_suite_id_check_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."check_suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_requests" ADD CONSTRAINT "check_requests_rerun_of_check_suites_id_fk" FOREIGN KEY ("rerun_of") REFERENCES "public"."check_suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_requests" ADD CONSTRAINT "check_requests_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_requests" ADD CONSTRAINT "check_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_requests" ADD CONSTRAINT "check_requests_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_suite_id_check_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."check_suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_suites" ADD CONSTRAINT "check_suites_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_suites" ADD CONSTRAINT "check_suites_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_forge_reports_by_next_attempt" ON "check_forge_reports" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "check_git_keys_by_token_hash" ON "check_git_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "check_git_keys_by_suite" ON "check_git_keys" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "check_requests_by_run" ON "check_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "check_requests_by_patch" ON "check_requests" USING btree ("patch_id");--> statement-breakpoint
CREATE INDEX "check_requests_by_state" ON "check_requests" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "check_requests_by_suite" ON "check_requests" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "check_requests_by_commit" ON "check_requests" USING btree ("connected_repo_id","commit");--> statement-breakpoint
CREATE UNIQUE INDEX "check_results_key" ON "check_results" USING btree ("suite_id","generation","name");--> statement-breakpoint
CREATE UNIQUE INDEX "check_suites_identity" ON "check_suites" USING btree ("connected_repo_id","commit","checks_blob","environment_key","inputs_key");--> statement-breakpoint
CREATE INDEX "check_suites_by_state" ON "check_suites" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "check_suites_by_environment" ON "check_suites" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "check_suites_by_commit" ON "check_suites" USING btree ("connected_repo_id","commit");