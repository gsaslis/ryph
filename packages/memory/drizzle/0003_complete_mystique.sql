CREATE INDEX "memories_by_provenance" ON "memories" USING gin ("provenance" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "memory_proposals_by_origin" ON "memory_proposals" USING gin ("origin" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "memory_runs_by_briefed" ON "memory_runs" USING gin ("briefed" jsonb_path_ops);