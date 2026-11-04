ALTER TABLE "agents" ADD COLUMN "network_policy" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "network_scope" jsonb DEFAULT '{"mode":"open","bundles":[],"hosts":[]}'::jsonb NOT NULL;--> statement-breakpoint
-- The default exists only to backfill the rows already here, and every one of them ran before any
-- egress boundary existed: `open` is what was true of them. Dropped immediately after, so the
-- column is NOT NULL with no default — which is what schema.ts declares, and what keeps
-- `pushSchema` from reporting drift on every later migration (tests/migrations_test.ts).
ALTER TABLE "runs" ALTER COLUMN "network_scope" DROP DEFAULT;