DROP INDEX "patches_merged_by_branch";--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "line" text DEFAULT 'work' NOT NULL;--> statement-breakpoint
CREATE INDEX "patches_merged_by_branch" ON "patches" USING btree ("run_id","connected_repo_id","path","line","generation") WHERE "patches"."landed" ->> 'kind' in ('merged', 'missed');--> statement-breakpoint
-- `tasks.landings` goes from one landing per checkout path to one per path and LINE: every
-- landing recorded before lines was the only line there was, the default one (`work`). A value
-- that is already a map of lines (no `connectedRepoId` of its own) is left as it is.
UPDATE "tasks" SET "landings" = (
  SELECT jsonb_object_agg(
    "entry"."key",
    CASE
      WHEN jsonb_typeof("entry"."value") = 'object' AND "entry"."value" ? 'connectedRepoId'
        THEN jsonb_build_object('work', "entry"."value")
      ELSE "entry"."value"
    END
  )
  FROM jsonb_each("tasks"."landings") AS "entry"
)
WHERE jsonb_typeof("landings") = 'object' AND EXISTS (
  SELECT 1 FROM jsonb_each("tasks"."landings") AS "entry"
  WHERE jsonb_typeof("entry"."value") = 'object' AND "entry"."value" ? 'connectedRepoId'
);--> statement-breakpoint
-- A repo entry's `branchName` is its `branchNamespace` now: the run's branch was one branch, and
-- is the namespace every line of the run ships under (`<namespace>/<line>`). The value is the
-- same string; only the key moves. Read without it, a live row's namespace is undefined: the
-- forge grant names no branch the run may push, and the landing reads no usable branch. Every
-- place a RepoEntry is stored: a task's `repos`, and a run's frozen `work_item.repos`. An entry
-- that already has the new key keeps its value; one with neither, and a non-array, is left alone.
UPDATE "tasks" SET "repos" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof("e"."entry") = 'object' AND "e"."entry" ? 'branchName'
        THEN ("e"."entry" - 'branchName') || jsonb_build_object(
          'branchNamespace',
          COALESCE("e"."entry" -> 'branchNamespace', "e"."entry" -> 'branchName')
        )
      ELSE "e"."entry"
    END
    ORDER BY "e"."ord"
  )
  FROM jsonb_array_elements("tasks"."repos") WITH ORDINALITY AS "e"("entry", "ord")
)
WHERE jsonb_typeof("repos") = 'array' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements("tasks"."repos") AS "e"("entry")
  WHERE jsonb_typeof("e"."entry") = 'object' AND "e"."entry" ? 'branchName'
);--> statement-breakpoint
UPDATE "runs" SET "work_item" = jsonb_set("work_item", '{repos}', (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof("e"."entry") = 'object' AND "e"."entry" ? 'branchName'
        THEN ("e"."entry" - 'branchName') || jsonb_build_object(
          'branchNamespace',
          COALESCE("e"."entry" -> 'branchNamespace', "e"."entry" -> 'branchName')
        )
      ELSE "e"."entry"
    END
    ORDER BY "e"."ord"
  )
  FROM jsonb_array_elements("runs"."work_item" -> 'repos') WITH ORDINALITY AS "e"("entry", "ord")
))
WHERE jsonb_typeof("work_item" -> 'repos') = 'array' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements("runs"."work_item" -> 'repos') AS "e"("entry")
  WHERE jsonb_typeof("e"."entry") = 'object' AND "e"."entry" ? 'branchName'
);
