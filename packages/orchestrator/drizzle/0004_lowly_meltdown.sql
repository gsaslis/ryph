ALTER TABLE "patches" ADD COLUMN "memory_fate_reported_at" text;--> statement-breakpoint
CREATE INDEX "patches_by_memory_fate" ON "patches" USING btree ("memory_fate_reported_at");