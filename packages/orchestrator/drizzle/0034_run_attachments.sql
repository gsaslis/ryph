CREATE TABLE "run_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"source" text NOT NULL,
	"storage_key" text NOT NULL,
	"claimed_by" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_messages" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run_attachments" ADD CONSTRAINT "run_attachments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_attachments_by_run" ON "run_attachments" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_attachments_unclaimed_by_age" ON "run_attachments" USING btree ("created_at") WHERE "run_attachments"."claimed_by" is null;