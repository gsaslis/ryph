CREATE TABLE "egress_allowlist" (
	"id" text PRIMARY KEY NOT NULL,
	"bundles" jsonb NOT NULL,
	"hosts" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text
);
