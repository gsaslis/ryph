DROP INDEX "patches_by_state";--> statement-breakpoint
DROP INDEX "tasks_by_agent";--> statement-breakpoint
DROP INDEX "tasks_by_created_at";--> statement-breakpoint
DROP INDEX "tasks_by_workspace";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_run_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_run_state" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_run_phase" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_activity_at" text;--> statement-breakpoint
UPDATE "tasks" SET
	"current_run_id" = "newest"."id",
	"current_run_state" = "newest"."state",
	"current_run_phase" = "newest"."phase",
	"last_activity_at" = "newest"."updated_at"
FROM (
	SELECT DISTINCT ON ("task_id") "task_id", "id", "state", "phase", "updated_at"
	FROM "runs"
	ORDER BY "task_id", "created_at" DESC, "id" DESC
) AS "newest"
WHERE "tasks"."id" = "newest"."task_id";--> statement-breakpoint
UPDATE "tasks" SET
	"current_run_id" = '',
	"current_run_state" = 'lost',
	"last_activity_at" = "created_at"
WHERE "current_run_id" IS NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "current_run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "current_run_state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "last_activity_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "patches_by_created_at" ON "patches" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_state" ON "tasks" USING btree ("current_run_state","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_origin" ON "tasks" USING btree ("origin","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_requester" ON "tasks" USING btree ("requested_by_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_repo" ON "tasks" USING gin ("repos" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "tasks_fts" ON "tasks" USING gin (to_tsvector('english', "spec_title"));--> statement-breakpoint
CREATE INDEX "patches_by_state" ON "patches" USING btree ("state","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_agent" ON "tasks" USING btree ("agent_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_created_at" ON "tasks" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_workspace" ON "tasks" USING btree ("workspace_id","created_at","id");