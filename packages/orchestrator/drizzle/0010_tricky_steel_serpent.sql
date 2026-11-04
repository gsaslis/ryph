CREATE TABLE "forge_tool_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tool" text NOT NULL,
	"connected_repo_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"number" integer,
	"state" text NOT NULL,
	"url" text,
	"created_number" integer,
	"detail" text,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "forge_policy" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "forge_scope" jsonb;--> statement-breakpoint
ALTER TABLE "forge_tool_actions" ADD CONSTRAINT "forge_tool_actions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forge_tool_actions_by_run" ON "forge_tool_actions" USING btree ("run_id","tool","created_at");