CREATE TABLE "reserved_capacity" (
	"id" text PRIMARY KEY NOT NULL,
	"slots" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text
);
