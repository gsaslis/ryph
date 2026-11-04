ALTER TABLE "environments" ADD COLUMN "egress_refusals" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "egress_refusals" jsonb;