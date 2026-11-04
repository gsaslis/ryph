ALTER TABLE "runs" ADD COLUMN "memory_outcome_reported_at" text;--> statement-breakpoint
CREATE INDEX "runs_by_memory_outcome" ON "runs" USING btree ("memory_outcome_reported_at");--> statement-breakpoint
-- Every run already concluded had its one outcome report before this column existed; there is no
-- telling now which were lost, and redelivering all of history on the first tick would be a storm.
UPDATE "runs" SET "memory_outcome_reported_at" = "updated_at"
  WHERE "state" IN ('succeeded', 'failed', 'errored', 'cancelled', 'lost');
