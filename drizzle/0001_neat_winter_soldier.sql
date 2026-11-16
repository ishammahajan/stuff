CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"audio" "bytea",
	"local_date" text NOT NULL,
	"time_zone" text NOT NULL,
	"transcript" text,
	"items" jsonb,
	"error" text
);
