ALTER TABLE "memory_runs" ADD COLUMN "changes" jsonb;--> statement-breakpoint
UPDATE "memory_runs" SET "changes" = (SELECT COALESCE(jsonb_object_agg(r, "change"), '{}'::jsonb) FROM jsonb_array_elements_text("repos") AS r);--> statement-breakpoint
ALTER TABLE "memory_runs" ALTER COLUMN "changes" SET NOT NULL;