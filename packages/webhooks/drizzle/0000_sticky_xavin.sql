CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"seq" bigserial NOT NULL,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"next_attempt_at" text,
	"lease_expires_at" text,
	"last_error" text,
	"received_at" text NOT NULL,
	"delivered_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_by_registration_seq" ON "webhooks" USING btree ("registration_id","seq");--> statement-breakpoint
CREATE INDEX "webhooks_by_registration_state" ON "webhooks" USING btree ("registration_id","state");