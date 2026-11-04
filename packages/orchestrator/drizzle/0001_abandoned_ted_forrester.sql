CREATE TABLE "automation_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"outcome" text NOT NULL,
	"task_id" text,
	"received_at" text NOT NULL,
	"created_at" text NOT NULL,
	"claimed_at" text
);
