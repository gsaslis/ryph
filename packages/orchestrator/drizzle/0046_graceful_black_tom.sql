ALTER TABLE "runs" ADD COLUMN "idle_state" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_run_idle_state" text;