CREATE TABLE "passages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"body" "bytea" NOT NULL,
	"embedding" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passages_user_idx" ON "passages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passages_record_idx" ON "passages" USING btree ("record_id");