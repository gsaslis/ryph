CREATE TABLE "mcp_revoked_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"revoked_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" text NOT NULL,
	"kind" text DEFAULT 'remote' NOT NULL,
	"url" text NOT NULL,
	"auth" text NOT NULL,
	"encrypted_auth" text,
	"auth_last4" text,
	"catalogue_id" text,
	"custom" jsonb,
	"settings" jsonb,
	"host_handle" text,
	"host_status" text,
	"host_image_digest" text,
	"host_started_at" text,
	"host_error" text,
	"archived_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_usage" (
	"seq" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"server_id" text NOT NULL,
	"method" text NOT NULL,
	"tool" text,
	"status" text NOT NULL,
	"http_status" integer,
	"duration_ms" integer NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_virtual_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" jsonb NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_live_slug" ON "mcp_servers" USING btree ("slug") WHERE "mcp_servers"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "mcp_usage_by_run" ON "mcp_usage" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_virtual_keys_by_token_hash" ON "mcp_virtual_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_virtual_keys_by_run" ON "mcp_virtual_keys" USING btree ("run_id");