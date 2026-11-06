ALTER TABLE "day_notes" ADD COLUMN "weekday" integer;--> statement-breakpoint
ALTER TABLE "day_notes" ADD COLUMN "window_start" text;--> statement-breakpoint
ALTER TABLE "day_notes" ADD COLUMN "window_end" text;--> statement-breakpoint
ALTER TABLE "day_notes" ADD COLUMN "start_after" text;--> statement-breakpoint
ALTER TABLE "day_notes" ADD COLUMN "end_by" text;--> statement-breakpoint
ALTER TABLE "day_notes" ADD COLUMN "reserve_for_project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "day_notes" ADD COLUMN "reserve_for_area_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "day_notes" ADD COLUMN "buffer_minutes" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "paused_until" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "series_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "defer_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_remind_idx" ON "tasks" USING btree ("remind_at");