-- A merge record for every change request a patch merged on before the records existed, so a
-- push that reaches one later is judged against what merged rather than left alone.
--
-- Its releases are owed (`released_at` NULL) only where a task whose current run is live still
-- targets it: the old code never let go of a task with nothing of its run on the change request,
-- and the release reconcile does so once (it stands aside for a task whose run has a patch there,
-- whose landing let it go). Everywhere else they are taken as made, so an old finished task is
-- never released or cued; a patch of one that reaches the sweep later is let go by the sweep's
-- gate. A backfilled record left unsettled may still record landings on old tasks when it
-- settles.
--
-- Settled, with the merged patches' heads (the newest twenty, newest first as the record keeps
-- them: what the containment read accepts), when nothing on it still owes a verdict: the old
-- settle's verdicts stand, and nothing is asked. Those heads are the old settle's `merged` rows,
-- which may include pushes the old code called merged wrongly (it took every patch on a merged
-- change request to be merged); a late push is judged against them. Accepted: it touches only
-- change requests that merged before this change was deployed. Unsettled with no
-- heads when a patch on it still owes one (submitted with none, or closed before a reopen and
-- merge): the old settle took every patch on it to be merged, so its heads may name pushes that
-- never merged, and the settle asks the forge's read of the change request what merged instead.
INSERT INTO "change_request_merges" ("connected_repo_id", "forge_ref", "merged_into", "heads", "merged_at", "version", "settled_at", "released_at")
SELECT c."connected_repo_id", c."forge_ref", c."merged_into",
  CASE WHEN c."owing" THEN '[]'::jsonb ELSE (
    SELECT coalesce(jsonb_agg(h."head_sha" ORDER BY h."created_at" DESC, h."id" DESC), '[]'::jsonb) FROM (
      SELECT q."head_sha", q."created_at", q."id" FROM "patches" q
      WHERE q."connected_repo_id" = c."connected_repo_id" AND q."forge_ref" = c."forge_ref"
        AND q."landed" ->> 'kind' = 'merged'
      ORDER BY q."created_at" DESC, q."id" DESC LIMIT 20) h
  ) END,
  c."merged_at", 1, CASE WHEN c."owing" THEN NULL ELSE c."merged_at" END,
  CASE WHEN EXISTS (
    SELECT 1 FROM "tasks" t JOIN "runs" r ON r."id" = t."current_run_id"
    WHERE t."target_change_request" ->> 'connectedRepoId' = c."connected_repo_id"
      AND t."target_change_request" ->> 'thread' = c."forge_ref"
      AND r."state" IN ('starting', 'running')
  ) THEN NULL ELSE c."merged_at" END
FROM (
  -- The branch each merged patch's verdict kept: one change request merges into one branch, and
  -- where old rows disagree `max` simply picks one of them.
  SELECT p."connected_repo_id", p."forge_ref", max(p."landed" ->> 'mergedInto') AS "merged_into",
    min(p."landed" ->> 'at') AS "merged_at",
    EXISTS (
      SELECT 1 FROM "patches" o
      WHERE o."connected_repo_id" = p."connected_repo_id" AND o."forge_ref" = p."forge_ref"
        AND o."state" = 'submitted' AND (o."landed" IS NULL OR o."landed" ->> 'kind' = 'closed')
    ) AS "owing"
  FROM "patches" p
  WHERE p."landed" ->> 'kind' = 'merged' AND p."forge_ref" IS NOT NULL
  GROUP BY p."connected_repo_id", p."forge_ref"
) c
ON CONFLICT DO NOTHING;
