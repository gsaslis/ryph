CREATE TABLE "merge_polls" (
	"connected_repo_id" text NOT NULL,
	"forge_ref" text NOT NULL,
	"due_at" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"gone" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "landing_asked_at" text;--> statement-breakpoint
ALTER TABLE "merge_polls" ADD CONSTRAINT "merge_polls_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_polls_by_change_request" ON "merge_polls" USING btree ("connected_repo_id","forge_ref");--> statement-breakpoint
CREATE INDEX "patches_awaiting_landing" ON "patches" USING btree ("created_at") WHERE "patches"."landing_asked_at" is null and "patches"."landed" ->> 'kind' = 'merged';--> statement-breakpoint
CREATE INDEX "patches_closed_by_time" ON "patches" USING btree (("landed" ->> 'at')) WHERE "patches"."state" = 'submitted' and "patches"."landed" ->> 'kind' = 'closed';--> statement-breakpoint
-- Backfill. A merged patch from before this migration had its landing asked when it merged (or,
-- settled before 0042, never needed one): none is owed again.
UPDATE "patches" SET "landing_asked_at" = "updated_at" WHERE "landed" ->> 'kind' = 'merged';
