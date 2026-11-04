DROP INDEX "chat_bindings_one_active";--> statement-breakpoint
ALTER TABLE "chat_bindings" ADD COLUMN "thread_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_bindings" ALTER COLUMN "thread_key" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chat_poll_cursors" ADD COLUMN "queue_id" text;--> statement-breakpoint
ALTER TABLE "chat_poll_cursors" ADD COLUMN "last_message_id" bigint;--> statement-breakpoint
ALTER TABLE "chatrooms" ADD COLUMN "realm_url" text;--> statement-breakpoint
ALTER TABLE "chatrooms" ADD COLUMN "bot_email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_bindings_one_active" ON "chat_bindings" USING btree ("chatroom_id","thread_key") WHERE "chat_bindings"."state" = 'active';