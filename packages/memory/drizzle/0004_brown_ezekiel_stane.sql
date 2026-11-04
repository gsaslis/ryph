ALTER TABLE "memory_runs" ADD COLUMN "repos" jsonb;--> statement-breakpoint
UPDATE "memory_runs" SET "repos" = CASE WHEN "repo" IS NULL THEN '[]'::jsonb ELSE jsonb_build_array("repo") END;--> statement-breakpoint
ALTER TABLE "memory_runs" ALTER COLUMN "repos" SET NOT NULL;