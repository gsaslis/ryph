ALTER TABLE "memory_runs" ADD COLUMN "task_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "memory_runs" ALTER COLUMN "task_id" DROP DEFAULT;
