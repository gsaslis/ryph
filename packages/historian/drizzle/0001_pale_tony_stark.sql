ALTER TABLE "history_events" DROP CONSTRAINT "history_events_run_id_seq_pk";--> statement-breakpoint
ALTER TABLE "history_events" ADD COLUMN "lane" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "history_events" ADD CONSTRAINT "history_events_run_id_lane_seq_pk" PRIMARY KEY("run_id","lane","seq");
