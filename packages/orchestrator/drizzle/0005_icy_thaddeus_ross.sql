CREATE TABLE "workspace_repos" (
	"workspace_id" text NOT NULL,
	"connected_repo_id" text NOT NULL,
	"ref" text,
	"path" text NOT NULL,
	"description" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_connected_repo_id_connected_repos_id_fk";
--> statement-breakpoint
DROP INDEX "tasks_by_connected_repo";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "repo_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "repo_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "target_pull_request" SET DATA TYPE jsonb USING CASE WHEN "target_pull_request" IS NULL THEN NULL ELSE jsonb_build_object('connectedRepoId', "connected_repo_id", 'number', "target_pull_request") END;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "set_id" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "path" text;--> statement-breakpoint
UPDATE "patches" SET "set_id" = "id", "path" = 'repo';--> statement-breakpoint
ALTER TABLE "patches" ALTER COLUMN "set_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "patches" ALTER COLUMN "path" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repos" jsonb;--> statement-breakpoint
UPDATE "tasks" SET "repos" = jsonb_build_array(jsonb_build_object(
	'connectedRepoId', "connected_repo_id",
	'name', COALESCE((SELECT "full_name" FROM "connected_repos" WHERE "connected_repos"."id" = "tasks"."connected_repo_id"), "repo_url"),
	'url', "repo_url",
	'ref', "repo_ref",
	'path', 'repo',
	'branchName', COALESCE((SELECT "branch_name" FROM "runs" WHERE "runs"."task_id" = "tasks"."id" ORDER BY "created_at" LIMIT 1), 'ryph/unknown/' || "tasks"."id"),
	'description', NULL
));--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "repos" SET NOT NULL;--> statement-breakpoint
UPDATE "runs" SET "work_item" = ("work_item" - 'repo' - 'branchName') || jsonb_build_object(
	'repos', jsonb_build_array(jsonb_build_object(
		'connectedRepoId', (SELECT "connected_repo_id" FROM "tasks" WHERE "tasks"."id" = "runs"."task_id"),
		'name', COALESCE((SELECT "repos"->0->>'name' FROM "tasks" WHERE "tasks"."id" = "runs"."task_id"), "work_item"->'repo'->>'url'),
		'url', "work_item"->'repo'->'url',
		'ref', "work_item"->'repo'->'ref',
		'path', 'repo',
		'branchName', "work_item"->'branchName',
		'description', NULL
	)),
	'workspace', NULL
) WHERE "work_item" ? 'repo';--> statement-breakpoint
UPDATE "runs" SET "result" = ("result" - 'branch') || jsonb_build_object('branches',
	CASE WHEN jsonb_typeof("result"->'branch') IS DISTINCT FROM 'object' THEN '[]'::jsonb
	ELSE jsonb_build_array(("result"->'branch') || jsonb_build_object(
		'connectedRepoId', (SELECT "connected_repo_id" FROM "tasks" WHERE "tasks"."id" = "runs"."task_id"),
		'path', 'repo'
	)) END
) WHERE "result" IS NOT NULL AND "result" ? 'branch';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "workspace_repos" ADD CONSTRAINT "workspace_repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_repos" ADD CONSTRAINT "workspace_repos_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repos_by_connected_repo" ON "workspace_repos" USING btree ("connected_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repos_by_path" ON "workspace_repos" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "workspace_repos_by_workspace" ON "workspace_repos" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patches_by_set" ON "patches" USING btree ("set_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_by_workspace" ON "tasks" USING btree ("workspace_id");