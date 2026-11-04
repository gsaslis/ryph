CREATE TABLE "run_background_commands" (
	"run_id" text NOT NULL,
	"job_id" text NOT NULL,
	"label" text NOT NULL,
	"command" text NOT NULL,
	"cwd" text NOT NULL,
	"service" boolean NOT NULL,
	"started_at" text NOT NULL,
	"timeout_at" text,
	"ended_at" text,
	"reason" text,
	"exit_code" integer,
	"signal" text,
	"log_bytes" integer DEFAULT 0 NOT NULL,
	"log_truncated" boolean DEFAULT false NOT NULL,
	"log_tail" text,
	"has_log" boolean DEFAULT false NOT NULL,
	"log_claim" text,
	"log_claimed_at" text,
	"log_key" text
);
--> statement-breakpoint
ALTER TABLE "run_background_commands" ADD CONSTRAINT "run_background_commands_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_background_commands_key" ON "run_background_commands" USING btree ("run_id","job_id");