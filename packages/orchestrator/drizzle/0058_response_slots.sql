DROP INDEX "responses_one_open";--> statement-breakpoint
ALTER TABLE "responses" ADD COLUMN "key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "responses" ADD COLUMN "title" text;--> statement-breakpoint
CREATE UNIQUE INDEX "responses_one_open" ON "responses" USING btree ("automation_id","key") WHERE "responses"."state" <> 'closed';