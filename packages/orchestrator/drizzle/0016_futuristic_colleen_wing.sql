ALTER TABLE "connected_repos" DROP COLUMN "full_name";--> statement-breakpoint
ALTER TABLE "forge_tool_actions" DROP COLUMN "repo_full_name";--> statement-breakpoint
ALTER TABLE "forge_tool_actions" DROP COLUMN "number";--> statement-breakpoint
ALTER TABLE "forge_tool_actions" DROP COLUMN "created_number";--> statement-breakpoint
ALTER TABLE "progress_comments" DROP COLUMN "thread_number";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "origin_thread_number";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "target_pull_request";