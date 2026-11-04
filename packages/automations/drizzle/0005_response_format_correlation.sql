-- Responses (#230): a webhook trigger gained a payload `format`, its verification a
-- `secretSource` (and a secret-header one a value `prefix`), and a response policy a
-- `correlation`. Every row saved before them gets the value that keeps it behaving exactly as
-- it did — written in, not defaulted at read, because the trigger and the policy are carried
-- verbatim to the app and to the orchestrator, which read every field as present:
--   * format `alertmanager`: what the orchestrator read before formats existed — a top-level
--     `status` of firing/resolved. The keys it also reads change nothing under the correlation
--     below, which ignores them.
--   * secretSource `minted`: no secret could be pasted before now.
--   * prefix `""`: a secret header was compared verbatim.
--   * correlation `automation`: one open response per automation, as before.
UPDATE "automations" SET "trigger" = "trigger" || '{"format": {"kind": "alertmanager"}}'::jsonb WHERE "trigger"->>'kind' = 'webhook' AND NOT ("trigger" ? 'format');
--> statement-breakpoint
UPDATE "automations" SET "trigger" = jsonb_set("trigger", '{verification}', ("trigger"->'verification') || '{"secretSource": "minted"}'::jsonb) WHERE "trigger"->>'kind' = 'webhook' AND jsonb_typeof("trigger"->'verification') = 'object' AND NOT ("trigger"->'verification' ? 'secretSource');
--> statement-breakpoint
UPDATE "automations" SET "trigger" = jsonb_set("trigger", '{verification}', ("trigger"->'verification') || '{"prefix": ""}'::jsonb) WHERE "trigger"->>'kind' = 'webhook' AND "trigger"->'verification'->>'kind' = 'secret-header' AND NOT ("trigger"->'verification' ? 'prefix');
--> statement-breakpoint
UPDATE "automations" SET "response" = "response" || '{"correlation": "automation"}'::jsonb WHERE "response" IS NOT NULL AND NOT ("response" ? 'correlation');
