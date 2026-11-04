CREATE TABLE "radicle_tracked_repos" (
	"rid" text PRIMARY KEY NOT NULL,
	"created_policy" boolean NOT NULL,
	"unseed_pending" boolean DEFAULT false NOT NULL,
	"tracked_at" text NOT NULL
);
