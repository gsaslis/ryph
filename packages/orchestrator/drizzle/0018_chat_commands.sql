CREATE TABLE "chat_mentions" (
	"chatroom_id" text NOT NULL,
	"message_id" text NOT NULL,
	"outcome" text NOT NULL,
	"task_id" text,
	"received_at" text NOT NULL,
	"created_at" text NOT NULL,
	"claimed_at" text
);
--> statement-breakpoint
CREATE TABLE "command_room_channels" (
	"chatroom_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"target" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_rooms" (
	"chatroom_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_ids" jsonb NOT NULL,
	"default_agent_id" text NOT NULL,
	"default_target" jsonb,
	"commanders" jsonb NOT NULL,
	"starts_per_hour" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "origin_chatroom_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "origin_thread_key" text;--> statement-breakpoint
ALTER TABLE "command_room_channels" ADD CONSTRAINT "command_room_channels_chatroom_id_command_rooms_chatroom_id_fk" FOREIGN KEY ("chatroom_id") REFERENCES "public"."command_rooms"("chatroom_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_rooms" ADD CONSTRAINT "command_rooms_default_agent_id_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_mentions_by_message" ON "chat_mentions" USING btree ("chatroom_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "command_room_channels_by_channel" ON "command_room_channels" USING btree ("chatroom_id","channel_id");--> statement-breakpoint
CREATE INDEX "runs_by_origin_chat" ON "runs" USING btree ("origin_chatroom_id","origin_thread_key");--> statement-breakpoint
CREATE INDEX "runs_by_origin_chatroom_created" ON "runs" USING btree ("origin_chatroom_id","created_at");