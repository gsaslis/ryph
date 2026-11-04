CREATE TABLE "artifact_publish_attempts" (
	"run_id" text NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_version_images" (
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"ref" text NOT NULL,
	"attachment_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"html" text NOT NULL,
	"served_html" text NOT NULL,
	"bytes" integer NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"requested_by" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"agent_id" text NOT NULL,
	"origin_run_id" text NOT NULL,
	"requested_by" text,
	"request_origin" text NOT NULL,
	"origin_chatroom_id" text,
	"origin_conversation" text,
	"current_version" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "can_publish_artifacts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "chat_conversation" text;--> statement-breakpoint
ALTER TABLE "artifact_publish_attempts" ADD CONSTRAINT "artifact_publish_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version_images" ADD CONSTRAINT "artifact_version_images_attachment_id_run_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."run_attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_origin_run_id_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_publish_attempts_by_run" ON "artifact_publish_attempts" USING btree ("run_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_version_images_key" ON "artifact_version_images" USING btree ("artifact_id","version","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_key" ON "artifact_versions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX "artifact_versions_by_run" ON "artifact_versions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "artifacts_by_updated" ON "artifacts" USING btree ("updated_at","id") WHERE "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "artifacts_by_origin_run" ON "artifacts" USING btree ("origin_run_id");