ALTER TABLE "runs" ADD COLUMN "origin_thread_repo_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "origin_thread_kind" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "origin_thread_number" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_origin_thread_repo_id_connected_repos_id_fk" FOREIGN KEY ("origin_thread_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_by_origin_thread" ON "runs" USING btree ("origin_thread_repo_id","origin_thread_number");