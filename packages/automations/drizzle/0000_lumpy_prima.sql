CREATE TABLE "automation_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"outcome" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"detail" text,
	"fired_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"trigger" jsonb NOT NULL,
	"next_due_at" text,
	"last_fired_at" text,
	"agent_id" text NOT NULL,
	"connected_repo_id" text NOT NULL,
	"ref" text,
	"instructions" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"seq" bigserial NOT NULL,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"next_attempt_at" text,
	"lease_expires_at" text,
	"last_error" text,
	"received_at" text NOT NULL,
	"delivered_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "automation_fires_by_automation" ON "automation_fires" USING btree ("automation_id","fired_at");--> statement-breakpoint
CREATE INDEX "automations_by_owner" ON "automations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "automations_by_due" ON "automations" USING btree ("enabled","next_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_by_registration_seq" ON "webhooks" USING btree ("registration_id","seq");--> statement-breakpoint
CREATE INDEX "webhooks_by_registration_state" ON "webhooks" USING btree ("registration_id","state");