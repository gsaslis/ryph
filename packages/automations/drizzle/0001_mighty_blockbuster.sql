ALTER TABLE "automations" ALTER COLUMN "connected_repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "target" jsonb;--> statement-breakpoint
UPDATE "automations" SET "target" = jsonb_build_object('kind', 'repo', 'connectedRepoId', "connected_repo_id", 'ref', "ref");--> statement-breakpoint
ALTER TABLE "automations" ALTER COLUMN "target" SET NOT NULL;