ALTER TABLE "memory_proposals" ADD COLUMN "basis" text NOT NULL DEFAULT 'observed';--> statement-breakpoint
ALTER TABLE "memory_proposals" ALTER COLUMN "basis" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "memory_runs" ADD COLUMN "change" text NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "memory_runs" ALTER COLUMN "change" DROP DEFAULT;
