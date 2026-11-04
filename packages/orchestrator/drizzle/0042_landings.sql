ALTER TABLE "patches" ADD COLUMN "forge_branch" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "diff_ref" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "merged_cued_at" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "merged_cue_claimed_at" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "held_reason" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "landings" jsonb;--> statement-breakpoint
CREATE INDEX "patches_awaiting_merged_cue" ON "patches" USING btree ("created_at") WHERE "patches"."merged_cued_at" is null and "patches"."landed" ->> 'kind' = 'merged';--> statement-breakpoint
CREATE INDEX "patches_merged_by_branch" ON "patches" USING btree ("run_id","connected_repo_id","path","generation") WHERE "patches"."landed" ->> 'kind' = 'merged';--> statement-breakpoint
CREATE INDEX "patches_unsettled" ON "patches" USING btree ("created_at") WHERE "patches"."state" = 'submitted' and "patches"."landed" is null;--> statement-breakpoint
-- Backfill. A merged patch from before this migration was told to its run when it merged:
-- its cue is not owed again.
UPDATE "patches" SET "merged_cued_at" = "updated_at" WHERE "landed" ->> 'kind' = 'merged';
