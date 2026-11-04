ALTER TABLE "runs" ADD COLUMN "declared_outcome" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_finished" boolean DEFAULT false NOT NULL;