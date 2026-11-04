CREATE TABLE "change_request_merges" (
	"connected_repo_id" text NOT NULL,
	"forge_ref" text NOT NULL,
	"merged_into" text,
	"heads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merged_at" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"settled_at" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_ask_at" text,
	"released_at" text,
	"release_retry_at" text
);
--> statement-breakpoint
DROP INDEX "patches_awaiting_merged_cue";--> statement-breakpoint
DROP INDEX "patches_awaiting_landing";--> statement-breakpoint
DROP INDEX "patches_merged_by_branch";--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "carries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "change_request_merges" ADD CONSTRAINT "change_request_merges_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_request_merges_by_change_request" ON "change_request_merges" USING btree ("connected_repo_id","forge_ref");--> statement-breakpoint
CREATE INDEX "change_request_merges_due" ON "change_request_merges" USING btree ("next_ask_at") WHERE "change_request_merges"."settled_at" is null or "change_request_merges"."next_ask_at" is not null;--> statement-breakpoint
CREATE INDEX "change_request_merges_owing_release" ON "change_request_merges" USING btree ("release_retry_at","merged_at") WHERE "change_request_merges"."released_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_by_target_change_request" ON "tasks" USING btree (("target_change_request" ->> 'connectedRepoId'),("target_change_request" ->> 'thread')) WHERE "tasks"."target_change_request" is not null;--> statement-breakpoint
CREATE INDEX "patches_awaiting_merged_cue" ON "patches" USING btree ("created_at") WHERE "patches"."merged_cued_at" is null and "patches"."landed" ->> 'kind' in ('merged', 'missed');--> statement-breakpoint
CREATE INDEX "patches_awaiting_landing" ON "patches" USING btree ("created_at") WHERE "patches"."landing_asked_at" is null and "patches"."landed" ->> 'kind' in ('merged', 'missed');--> statement-breakpoint
CREATE INDEX "patches_merged_by_branch" ON "patches" USING btree ("run_id","connected_repo_id","path","generation") WHERE "patches"."landed" ->> 'kind' in ('merged', 'missed');