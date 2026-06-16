ALTER TABLE "invites" DROP CONSTRAINT "invites_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "member_id";