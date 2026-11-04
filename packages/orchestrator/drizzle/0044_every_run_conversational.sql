ALTER TABLE "tasks" ALTER COLUMN "lifetime" DROP DEFAULT;--> statement-breakpoint
UPDATE "tasks" SET "lifetime" = jsonb_build_object('idleMs', COALESCE("lifetime"->'idleMs', '300000'::jsonb), 'attendedIdleMs', COALESCE("lifetime"->'attendedIdleMs', '1800000'::jsonb));--> statement-breakpoint
UPDATE "runs" SET "work_item" = jsonb_set("work_item", '{lifetime}', jsonb_build_object('idleMs', COALESCE("work_item"->'lifetime'->'idleMs', '300000'::jsonb), 'attendedIdleMs', COALESCE("work_item"->'lifetime'->'attendedIdleMs', '1800000'::jsonb))) WHERE "work_item" ? 'lifetime';
