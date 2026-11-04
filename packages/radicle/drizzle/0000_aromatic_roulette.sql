CREATE TABLE "radicle_cursors" (
	"rid" text NOT NULL,
	"ref" text NOT NULL,
	"oid" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "radicle_cursors_by_rid_ref" ON "radicle_cursors" USING btree ("rid","ref");