UPDATE "users" SET "role" = 'owner' WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "users" SET "role" = 'member' WHERE "role" = 'user';--> statement-breakpoint
UPDATE "invites" SET "role" = 'owner' WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "invites" SET "role" = 'member' WHERE "role" = 'user';
