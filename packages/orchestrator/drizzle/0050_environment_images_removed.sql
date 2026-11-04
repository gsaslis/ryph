ALTER TABLE "environments" ADD COLUMN "images_removed_at" text;--> statement-breakpoint
CREATE INDEX "environments_by_baked_image" ON "environments" USING btree ("baked_image");