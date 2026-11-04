ALTER TABLE "run_attachments" ADD COLUMN "ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "run_attachments_ref" ON "run_attachments" USING btree ("run_id","ref");