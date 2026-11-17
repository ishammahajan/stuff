-- Captures from before accounts existed belong to no one and are deleted.
DELETE FROM "captures" WHERE "user_id" IS NULL OR "body" IS NULL;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "body" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" DROP COLUMN "local_date";--> statement-breakpoint
ALTER TABLE "captures" DROP COLUMN "time_zone";--> statement-breakpoint
ALTER TABLE "captures" DROP COLUMN "transcript";--> statement-breakpoint
ALTER TABLE "captures" DROP COLUMN "items";--> statement-breakpoint
ALTER TABLE "captures" DROP COLUMN "error";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "adopt_unowned";