CREATE TABLE "run_bootstraps" (
	"run_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"sealed" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_bootstraps" ADD CONSTRAINT "run_bootstraps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;