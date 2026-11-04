-- Forge reports go from one per submitted patch to one per asker the forge hears about: a
-- patch's, or a push request's (a push to any change request). Every row standing is a patch's:
-- it gets an id of its own, keeps its patch_id, and is given the base its checks are read at — its
-- patch's newest request's, else the repo's default branch, where a patch with no request on
-- record is judged unless its task named another base.
ALTER TABLE "check_forge_reports" ADD COLUMN "id" text;--> statement-breakpoint
UPDATE "check_forge_reports" SET "id" = 'fr-' || substr(md5("patch_id"), 1, 10);--> statement-breakpoint
ALTER TABLE "check_forge_reports" DROP CONSTRAINT "check_forge_reports_pkey";--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "check_forge_reports" ALTER COLUMN "patch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD COLUMN "checks_ref" text;--> statement-breakpoint
UPDATE "check_forge_reports" AS r SET "checks_ref" = coalesce(
  (SELECT q."checks_ref" FROM "check_requests" AS q WHERE q."patch_id" = r."patch_id" ORDER BY q."created_at" DESC, q."id" DESC LIMIT 1),
  (SELECT c."default_branch" FROM "connected_repos" AS c WHERE c."id" = r."connected_repo_id")
);--> statement-breakpoint
ALTER TABLE "check_forge_reports" ALTER COLUMN "checks_ref" SET NOT NULL;--> statement-breakpoint
-- A push request names its change request in a column of its own, so its earlier pushes are
-- found by an index. No push request exists before this migration.
ALTER TABLE "check_requests" ADD COLUMN "change_request" text;--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD CONSTRAINT "check_forge_reports_request_id_check_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."check_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "check_forge_reports_by_patch" ON "check_forge_reports" USING btree ("patch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "check_forge_reports_by_request" ON "check_forge_reports" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "check_requests_by_change_request" ON "check_requests" USING btree ("connected_repo_id","change_request");--> statement-breakpoint
ALTER TABLE "check_forge_reports" ADD CONSTRAINT "check_forge_reports_one_asker" CHECK (("check_forge_reports"."patch_id" is null) <> ("check_forge_reports"."request_id" is null));
--> statement-breakpoint
-- A local ask (a person asking for checks from their own machine) names its asker and its end in
-- columns of their own: the asker so their live asks are found by an index (to supersede on the
-- same branch, to count against their cap), the end so the minute sweep finds the ones past it.
-- And every bundle a person streams to the forge for one is a row of its own, written before the
-- upload whatever the forge answers, so the hourly upload cap counts attempts. No local request
-- or upload exists before this migration.
CREATE TABLE "check_local_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connected_repo_id" text NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_requests" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "check_requests" ADD COLUMN "expires_at" text;--> statement-breakpoint
ALTER TABLE "check_local_uploads" ADD CONSTRAINT "check_local_uploads_connected_repo_id_connected_repos_id_fk" FOREIGN KEY ("connected_repo_id") REFERENCES "public"."connected_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_local_uploads_by_user" ON "check_local_uploads" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "check_requests_by_user" ON "check_requests" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "check_requests_by_expiry" ON "check_requests" USING btree ("kind","state","expires_at");