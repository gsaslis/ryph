CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"handle" text,
	"email" text NOT NULL,
	"system_prompt" text,
	"harness_kind" text NOT NULL,
	"model_policy" jsonb,
	"tool_policy" jsonb,
	"archived_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"full_name" text NOT NULL,
	"url" text NOT NULL,
	"default_branch" text NOT NULL,
	"submission_policy" text DEFAULT 'require-approval' NOT NULL,
	"archived_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forge_events" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"task_id" text,
	"received_at" text NOT NULL,
	"created_at" text NOT NULL,
	"claimed_at" text
);
--> statement-breakpoint
CREATE TABLE "git_virtual_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_user_identities" (
	"user_id" text PRIMARY KEY NOT NULL,
	"github_login" text NOT NULL,
	"sealed_access_token" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patches" (
	"id" text PRIMARY KEY NOT NULL,
	"connected_repo_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"branch_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"bundle_key" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"next_attempt_at" text,
	"lease_expires_at" text,
	"last_error" text,
	"approved_by" jsonb,
	"approved_at" text,
	"forge_ref" text,
	"forge_url" text,
	"superseded_by_patch_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_comments" (
	"run_id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"connected_repo_id" text NOT NULL,
	"thread_kind" text NOT NULL,
	"thread_number" integer NOT NULL,
	"comment_id" text NOT NULL,
	"last_posted" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"concluded_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"seq" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"at" text NOT NULL,
	"kind" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"state" text NOT NULL,
	"phase" text,
	"heartbeat_seq" integer NOT NULL,
	"last_heartbeat_at" text,
	"desired_state" text,
	"cancel_requested_at" text,
	"cancel_url" text,
	"token_hash" text NOT NULL,
	"control_token" text NOT NULL,
	"handle" text,
	"branch_name" text NOT NULL,
	"image" text,
	"work_item" jsonb NOT NULL,
	"injected_context" jsonb,
	"model_scope" jsonb,
	"tool_scope" jsonb,
	"services" jsonb,
	"result" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"spec_title" text NOT NULL,
	"spec_instructions" text NOT NULL,
	"repo_url" text NOT NULL,
	"repo_ref" text NOT NULL,
	"connected_repo_id" text,
	"origin" text DEFAULT 'user' NOT NULL,
	"requested_by_user_id" text,
	"target_pull_request" integer,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"private_jwk" jsonb NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_virtual_keys" ADD CONSTRAINT "git_virtual_keys_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_comments" ADD CONSTRAINT "progress_comments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_comments" ADD CONSTRAINT "progress_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_comments" ADD CONSTRAINT "progress_comments_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_by_harness_kind" ON "agents" USING btree ("harness_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_by_handle" ON "agents" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "connected_repos_by_installation" ON "connected_repos" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "connected_repos_by_full_name" ON "connected_repos" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "git_virtual_keys_by_token_hash" ON "git_virtual_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "git_virtual_keys_by_run" ON "git_virtual_keys" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_by_installation_id" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_user_identities_by_login" ON "github_user_identities" USING btree ("github_login");--> statement-breakpoint
CREATE INDEX "patches_by_repo_and_head" ON "patches" USING btree ("connected_repo_id","head_sha");--> statement-breakpoint
CREATE INDEX "patches_by_state" ON "patches" USING btree ("state");--> statement-breakpoint
CREATE INDEX "patches_by_task" ON "patches" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "patches_by_run" ON "patches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "progress_comments_open" ON "progress_comments" USING btree ("concluded_at");--> statement-breakpoint
CREATE INDEX "run_events_by_run" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_by_task" ON "runs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_by_agent" ON "runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_by_state" ON "runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "runs_by_last_heartbeat" ON "runs" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "tasks_by_agent" ON "tasks" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_by_created_at" ON "tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tasks_by_connected_repo" ON "tasks" USING btree ("connected_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_by_token_hash" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_by_user" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_by_email" ON "users" USING btree ("email");