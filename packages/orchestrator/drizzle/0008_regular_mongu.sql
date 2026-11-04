CREATE TABLE "responses" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"chatroom_id" text,
	"state" text NOT NULL,
	"alerts" integer DEFAULT 0 NOT NULL,
	"opened_at" text NOT NULL,
	"last_alert_at" text NOT NULL,
	"last_activity_at" text NOT NULL,
	"closed_at" text,
	"closed_reason" text
);
--> statement-breakpoint
CREATE TABLE "run_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"sender" jsonb NOT NULL,
	"text" text NOT NULL,
	"payload" jsonb,
	"created_at" text NOT NULL,
	"delivered_at" text
);
--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "base_sha" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "commits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "idle_deadline_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lifetime" jsonb DEFAULT '{"kind":"one-shot"}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "runs" SET "work_item" = "work_item" || '{"lifetime":{"kind":"one-shot"}}'::jsonb WHERE NOT ("work_item" ? 'lifetime');--> statement-breakpoint
UPDATE "runs" SET "result" = "result" || jsonb_build_object('branches',
	(SELECT COALESCE(jsonb_agg(b || '{"generation":1}'::jsonb), '[]'::jsonb) FROM jsonb_array_elements("result"->'branches') AS b)
) WHERE "result" IS NOT NULL AND jsonb_typeof("result"->'branches') = 'array';--> statement-breakpoint
UPDATE "patches" SET "commits" = COALESCE(
	(SELECT b->'commits' FROM "runs", jsonb_array_elements("runs"."result"->'branches') AS b
		WHERE "runs"."id" = "patches"."run_id" AND b->>'path' = "patches"."path"
		AND jsonb_typeof(b->'commits') = 'array' LIMIT 1),
	'[]'::jsonb
);--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responses_by_automation" ON "responses" USING btree ("automation_id","state");--> statement-breakpoint
CREATE INDEX "responses_by_run" ON "responses" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_messages_by_run_and_seq" ON "run_messages" USING btree ("run_id","seq");