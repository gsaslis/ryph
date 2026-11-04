DROP INDEX "webhooks_by_registration_state";--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "webhooks_live_by_queue" ON "webhooks" USING btree ("registration_id","scope","seq") WHERE "webhooks"."state" in ('pending', 'delivering');--> statement-breakpoint
CREATE INDEX "webhooks_terminal_by_age" ON "webhooks" USING btree ("registration_id","updated_at") WHERE "webhooks"."state" in ('delivered', 'exhausted');--> statement-breakpoint
CREATE INDEX "webhooks_delivered_by_key" ON "webhooks" USING btree ("registration_id","scope","dedupe_key") WHERE "webhooks"."dedupe_key" is not null;