DROP INDEX "memory_changes_by_run";--> statement-breakpoint
CREATE UNIQUE INDEX "memory_changes_by_run" ON "memory_changes" USING btree ("run_id","seq");