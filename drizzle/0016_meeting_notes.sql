CREATE TABLE "meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"event_key" text,
	"status" text DEFAULT 'recording' NOT NULL,
	"recorded" boolean DEFAULT true NOT NULL,
	"transcript" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"summary" jsonb,
	"seconds" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "meeting_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_user_idx" ON "meetings" USING btree ("user_id","started_at");