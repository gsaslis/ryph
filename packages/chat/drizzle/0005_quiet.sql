ALTER TABLE "chat_bindings" ADD COLUMN "quiet" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chatrooms" ADD COLUMN "quiet" boolean DEFAULT false NOT NULL;