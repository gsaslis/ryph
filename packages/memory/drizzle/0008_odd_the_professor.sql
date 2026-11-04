CREATE TABLE "memory_changes" (
	"patch_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"repo" text NOT NULL,
	"generation" integer NOT NULL,
	"seq" integer NOT NULL,
	"head_sha" text,
	"forge_url" text,
	"fate" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD COLUMN "change_id" text;--> statement-breakpoint
CREATE INDEX "memory_changes_by_run" ON "memory_changes" USING btree ("run_id","seq");--> statement-breakpoint
INSERT INTO "memory_changes" ("patch_id","run_id","tenant_id","repo","generation","seq","head_sha","forge_url","fate","created_at","updated_at")
SELECT 'legacy:' || r."run_id" || ':' || c.key, r."run_id", r."tenant_id", c.key, 1,
  (row_number() OVER (PARTITION BY r."run_id" ORDER BY c.ordinality) - 1)::int, NULL, NULL, c.value, r."created_at", r."created_at"
FROM "memory_runs" r, jsonb_each_text(r."changes") WITH ORDINALITY AS c(key, value, ordinality)
WHERE c.value IN ('pending', 'landed', 'dropped');--> statement-breakpoint
UPDATE "memory_proposals" p SET "change_id" = latest."patch_id"
FROM (SELECT DISTINCT ON ("run_id") "run_id", "patch_id" FROM "memory_changes" ORDER BY "run_id", "seq" DESC) latest
WHERE p."change_id" IS NULL AND p."status" = 'pending' AND p."basis" = 'introduced'
  AND p."origin" ->> 'kind' = 'run' AND p."origin" ->> 'runId' = latest."run_id";