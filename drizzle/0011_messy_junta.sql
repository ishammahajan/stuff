CREATE TABLE "statement_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"body" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "statement_rows" ADD CONSTRAINT "statement_rows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statement_rows_user_status_idx" ON "statement_rows" USING btree ("user_id","status");