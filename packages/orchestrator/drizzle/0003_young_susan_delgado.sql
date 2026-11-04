ALTER TABLE "patches" ADD COLUMN "landed" jsonb;--> statement-breakpoint
CREATE INDEX "patches_by_repo_and_forge_ref" ON "patches" USING btree ("connected_repo_id","forge_ref");