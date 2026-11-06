ALTER TABLE "tasks" ADD COLUMN "waiting_on" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "checklist" jsonb DEFAULT '[]'::jsonb NOT NULL;