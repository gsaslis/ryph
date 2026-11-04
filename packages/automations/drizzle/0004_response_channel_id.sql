-- A response policy gained `channelId` (Zulip only: the channel each response opens its topic
-- in). Every policy saved before it is a Telegram room's, or names no room, so the field is null
-- there — written in, not defaulted at read, because the policy is carried verbatim to the app
-- and to the orchestrator, both of which read the field as required.
UPDATE "automations" SET "response" = "response" || '{"channelId": null}'::jsonb WHERE "response" IS NOT NULL AND NOT ("response" ? 'channelId');
