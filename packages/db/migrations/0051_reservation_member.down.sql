-- ============================================================
-- AeroOps — DOWN migration for 0051_reservation_member.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- Review carefully before running. Reverses 0051 in exact reverse order.
--
-- Applying this DISCARDS who every booking was for (member_user_id), for every
-- org. The reservations themselves, created_by, notes and the audit_log rows
-- are untouched (each reservation.created audit row still names the member in
-- its metadata).
--
-- Roll the application back to a build without memberUserId FIRST: the
-- reservation Drizzle schema of a build that has it lists the column, so its
-- reservation INSERT (every booking) fails once the column is gone.
--
-- Reverses (in order — reverse of up):
--   (3) DROP the partial index
--   (2) DROP the composite FK
--   (1) DROP COLUMN reservation.member_user_id
-- ============================================================

DROP INDEX IF EXISTS "reservation_org_id_member_user_id_idx";

ALTER TABLE "reservation" DROP CONSTRAINT IF EXISTS "reservation_member_user_id_org_fk";

ALTER TABLE "reservation" DROP COLUMN IF EXISTS "member_user_id";
