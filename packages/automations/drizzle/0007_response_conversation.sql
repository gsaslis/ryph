-- A response policy gained `conversation`: whether each response opens a conversation of its own
-- in the channel, or all of them share one. Every policy saved before it opened one per response,
-- so that is what it says — written in, not defaulted at read, because the policy is carried
-- verbatim to the app and to the orchestrator, both of which read the field as required.
UPDATE "automations" SET "response" = "response" || '{"conversation": "per-response"}'::jsonb WHERE "response" IS NOT NULL AND NOT ("response" ? 'conversation');
