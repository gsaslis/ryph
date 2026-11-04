ALTER TABLE "check_suites" ADD COLUMN "pods" jsonb;--> statement-breakpoint
ALTER TABLE "check_suites" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;