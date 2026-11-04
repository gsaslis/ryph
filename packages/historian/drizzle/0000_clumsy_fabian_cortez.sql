CREATE TABLE "history_concluded_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" text NOT NULL,
	"voice" text NOT NULL,
	"kind" text NOT NULL,
	"level" text,
	"text" text,
	"payload" jsonb,
	CONSTRAINT "history_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
