ALTER TABLE "patches" ADD COLUMN "hook_check" jsonb;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "approved_hook_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;