CREATE TABLE "repo_command_allowlist" (
	"connected_repo_id" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"used_at" text
);
--> statement-breakpoint
DROP INDEX "connected_repos_by_full_name";--> statement-breakpoint
DROP INDEX "runs_by_origin_thread";--> statement-breakpoint
ALTER TABLE "connected_repos" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
-- The default exists only to backfill the rows already here: every repo connected before a
-- second forge existed is on GitHub. Dropped immediately after, so the column is NOT NULL with
-- no default — which is what schema.ts declares, and what keeps `pushSchema` from reporting
-- drift on every later migration (tests/migrations_test.ts).
ALTER TABLE "connected_repos" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_repos" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
-- The opaque per-provider address replaces "owner/name". Added nullable, backfilled from the
-- column it replaces, then made NOT NULL: a NOT NULL column without a default is rejected
-- outright by every row already there.
ALTER TABLE "connected_repos" ADD COLUMN "repo_ref" text;--> statement-breakpoint
UPDATE "connected_repos" SET "repo_ref" = "full_name";--> statement-breakpoint
ALTER TABLE "connected_repos" ALTER COLUMN "repo_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_tool_actions" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_tool_actions" ADD COLUMN "repo_ref" text;--> statement-breakpoint
UPDATE "forge_tool_actions" SET "repo_ref" = "repo_full_name";--> statement-breakpoint
ALTER TABLE "forge_tool_actions" ALTER COLUMN "repo_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_tool_actions" ADD COLUMN "thread_ref" text;--> statement-breakpoint
ALTER TABLE "forge_tool_actions" ADD COLUMN "created_thread_ref" text;--> statement-breakpoint
-- A thread is addressed by text from here on: GitHub's integers are one forge's spelling, and
-- a Radicle collaborative-object id is not a number at all.
UPDATE "forge_tool_actions" SET "thread_ref" = "number"::text, "created_thread_ref" = "created_number"::text;--> statement-breakpoint
ALTER TABLE "progress_comments" ADD COLUMN "thread_ref" text;--> statement-breakpoint
UPDATE "progress_comments" SET "thread_ref" = "thread_number"::text;--> statement-breakpoint
ALTER TABLE "progress_comments" ALTER COLUMN "thread_ref" SET NOT NULL;--> statement-breakpoint
UPDATE "progress_comments" SET "thread_kind" = 'change_request' WHERE "thread_kind" = 'pull_request';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "origin_thread_ref" text;--> statement-breakpoint
UPDATE "runs" SET "origin_thread_ref" = "origin_thread_number"::text;--> statement-breakpoint
UPDATE "runs" SET "origin_thread_kind" = 'change_request' WHERE "origin_thread_kind" = 'pull_request';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "target_change_request" jsonb;--> statement-breakpoint
-- `jsonb_typeof(...) = 'object'` rather than `IS NOT NULL`: `->>` on a jsonb SCALAR is not an
-- error but `jsonb_build_object` over it writes nonsense, and the `jsonb_set` walk below fails
-- outright on one — which wedges the migrate job, and a wedged migrate job is a deploy that
-- does not start. A column that is not an object is not a thing this migration converts.
UPDATE "tasks" SET "target_change_request" = jsonb_build_object('connectedRepoId', "target_pull_request"->>'connectedRepoId', 'thread', "target_pull_request"->>'number') WHERE jsonb_typeof("target_pull_request") = 'object';--> statement-breakpoint
-- A live run's frozen forge scope holds the same two renames inside jsonb, and the forge
-- refuses a grant it cannot parse — so a run still working when this lands keeps its tools.
UPDATE "runs" SET "forge_scope" = jsonb_set(jsonb_set(jsonb_set("forge_scope", '{repos}', (SELECT coalesce(jsonb_agg(jsonb_build_object('connectedRepoId', r->>'connectedRepoId', 'provider', 'github', 'repoRef', r->>'fullName', 'tenantId', r->'tenantId')), '[]'::jsonb) FROM jsonb_array_elements("forge_scope"->'repos') AS r)), '{sourceRepos}', (SELECT coalesce(jsonb_agg(jsonb_build_object('connectedRepoId', s->>'connectedRepoId', 'provider', 'github', 'repoRef', s->>'fullName', 'tenantId', s->'tenantId')), '[]'::jsonb) FROM jsonb_array_elements("forge_scope"->'sourceRepos') AS s)), '{origin}', CASE WHEN "forge_scope"->'origin' IS NULL OR "forge_scope"->'origin' = 'null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('connectedRepoId', "forge_scope"->'origin'->>'connectedRepoId', 'kind', CASE WHEN "forge_scope"->'origin'->>'kind' = 'pull_request' THEN 'change_request' ELSE "forge_scope"->'origin'->>'kind' END, 'ref', "forge_scope"->'origin'->>'number') END) WHERE jsonb_typeof("forge_scope") = 'object';--> statement-breakpoint
-- And the same for a forge follow-up already sitting in a run's inbox.
UPDATE "run_messages" SET "sender" = jsonb_build_object('kind', 'forge', 'login', "sender"->>'login', 'repoRef', "sender"->>'repoFullName', 'thread', "sender"->>'threadNumber') WHERE jsonb_typeof("sender") = 'object' AND "sender"->>'kind' = 'forge';--> statement-breakpoint
ALTER TABLE "repo_command_allowlist" ADD CONSTRAINT "repo_command_allowlist_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_challenges" ADD CONSTRAINT "identity_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_command_allowlist_entry" ON "repo_command_allowlist" USING btree ("connected_repo_id","provider","subject");--> statement-breakpoint
CREATE INDEX "repo_command_allowlist_by_repo" ON "repo_command_allowlist" USING btree ("connected_repo_id","created_at");--> statement-breakpoint
CREATE INDEX "identity_challenges_by_user" ON "identity_challenges" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "identity_challenges_by_expiry" ON "identity_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "connected_repos_by_repo_ref" ON "connected_repos" USING btree ("provider","repo_ref");--> statement-breakpoint
CREATE INDEX "runs_by_origin_thread" ON "runs" USING btree ("origin_thread_repo_id","origin_thread_ref");
