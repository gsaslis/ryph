ALTER TABLE "agents" ADD COLUMN "limit_policy" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "limits" jsonb DEFAULT '{"wallClockMs":null,"spendUsd":null,"callsInFlight":null}'::jsonb NOT NULL;--> statement-breakpoint
-- The default exists only to backfill the rows already here, and every one of them ran before any
-- limit existed: uncapped is what was true of them. Dropped immediately after, so the column is
-- NOT NULL with no default — which is what schema.ts declares, and what keeps `pushSchema` from
-- reporting drift on every later migration (tests/migrations_test.ts).
ALTER TABLE "runs" ALTER COLUMN "limits" DROP DEFAULT;
