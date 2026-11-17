CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"adopt_unowned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"password_salt" "bytea" NOT NULL,
	"password_key" "bytea" NOT NULL,
	"recovery_salt" "bytea" NOT NULL,
	"recovery_key" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "local_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "time_zone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "body" "bytea";--> statement-breakpoint
-- Sessions from the single-password era belong to no user. Signing everyone out
-- once lets the new required columns be added.
DELETE FROM "sessions";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "key" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captures_user_created_idx" ON "captures" USING btree ("user_id","created_at");