CREATE TABLE "chat_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"chatroom_id" text NOT NULL,
	"run_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"task_title" text NOT NULL,
	"run_url" text,
	"state" text NOT NULL,
	"created_at" text NOT NULL,
	"closed_at" text
);
--> statement-breakpoint
CREATE TABLE "chat_poll_cursors" (
	"chatroom_id" text PRIMARY KEY NOT NULL,
	"offset" integer NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatrooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"bot_username" text NOT NULL,
	"bot_id" text NOT NULL,
	"sealed_bot_token" text NOT NULL,
	"chat_id" text,
	"chat_title" text,
	"owner_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
ALTER TABLE "chat_bindings" ADD CONSTRAINT "chat_bindings_chatroom_id_chatrooms_id_fk" FOREIGN KEY ("chatroom_id") REFERENCES "public"."chatrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_poll_cursors" ADD CONSTRAINT "chat_poll_cursors_chatroom_id_chatrooms_id_fk" FOREIGN KEY ("chatroom_id") REFERENCES "public"."chatrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_bindings_by_run" ON "chat_bindings" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_bindings_by_room" ON "chat_bindings" USING btree ("chatroom_id","state");--> statement-breakpoint
CREATE INDEX "chatrooms_by_owner" ON "chatrooms" USING btree ("owner_user_id");