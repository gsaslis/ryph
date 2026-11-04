CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_url" text,
	"audience_kind" text NOT NULL,
	"audience_agent_id" text,
	"status" text NOT NULL,
	"trust" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"evidence" jsonb,
	"supersedes" text,
	"superseded_by" text,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"refutations" integer DEFAULT 0 NOT NULL,
	"briefed_count" integer DEFAULT 0 NOT NULL,
	"briefed_successes" integer DEFAULT 0 NOT NULL,
	"last_briefed_at" text,
	"last_confirmed_at" text,
	"last_refuted_at" text,
	"embedding" jsonb,
	"embedding_model" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_feedback" (
	"seq" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"memory_id" text,
	"run_id" text,
	"user_id" text,
	"detail" jsonb NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"text" text NOT NULL,
	"kind" text,
	"subject_kind" text,
	"subject_url" text,
	"audience_kind" text,
	"audience_agent_id" text,
	"evidence" jsonb,
	"origin" jsonb NOT NULL,
	"supersedes" text,
	"status" text NOT NULL,
	"resolution" jsonb,
	"flags" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"repo" text,
	"briefed" jsonb NOT NULL,
	"outcome" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"extraction" jsonb,
	"failure" text,
	"title" text NOT NULL,
	"locator" text,
	"content_hash" text NOT NULL,
	"text" text NOT NULL,
	"default_subject_kind" text NOT NULL,
	"default_subject_url" text,
	"ingested_by" text NOT NULL,
	"ingested_at" text NOT NULL,
	"supersedes_source_id" text
);
--> statement-breakpoint
CREATE INDEX "memories_by_subject" ON "memories" USING btree ("tenant_id","subject_kind","subject_url","status");--> statement-breakpoint
CREATE INDEX "memories_by_audience" ON "memories" USING btree ("tenant_id","audience_kind","audience_agent_id");--> statement-breakpoint
CREATE INDEX "memories_by_normalized" ON "memories" USING btree ("tenant_id","subject_kind","subject_url","normalized_text");--> statement-breakpoint
CREATE INDEX "memories_fts" ON "memories" USING gin (to_tsvector('english', "text"));--> statement-breakpoint
CREATE INDEX "memory_feedback_by_memory" ON "memory_feedback" USING btree ("memory_id","seq");--> statement-breakpoint
CREATE INDEX "memory_feedback_by_run" ON "memory_feedback" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "memory_proposals_by_status" ON "memory_proposals" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_sources_by_hash" ON "memory_sources" USING btree ("tenant_id","content_hash");