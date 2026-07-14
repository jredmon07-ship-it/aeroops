-- ============================================================
-- AeroOps — Member profile photos (avatars)
-- Migration: 0048_avatars.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0047_org_features.sql must already
--               be applied.
--
-- CONTEXT: an optional small profile photo per account (Flight Circle parity).
-- Stored INLINE as a size-capped data-URI TEXT column on app_user — no object
-- storage dependency (the S3 document pipeline is env-gated and absent on the
-- demo deploy). The client downscales to ≤256px before upload; the server
-- validates the data-URI shape and size; this CHECK is the DB backstop.
--
-- Key guarantees:
--   (a) STRICTLY ADDITIVE — one nullable column, no DEFAULT needed, no
--       backfill. No existing table, column, constraint, index, policy, or
--       grant is modified or dropped.
--   (b) GRACEFUL ABSENCE: until applied, the column does not exist; every
--       consumer probes information_schema first and degrades to
--       initials-only avatars (byte-identical to today).
--   (c) Tenant isolation inherited: app_user already carries org_id +
--       ENABLE+FORCE RLS (migration 0000) — an avatar is exactly as scoped as
--       the user row it sits on.
--   (d) An avatar is a STORED, NEVER-INTERPRETED image (mirrors the document
--       posture): displayed back to the same org only; no processing beyond
--       browser rendering.
--
--   Size bound: 160,000 chars ≈ 117 KB of base64-decoded image — far above
--   what a 256px avatar needs (~10-30 KB webp/jpeg), far below anything that
--   could bloat a row page badly. Data-URI prefix enforced so the column can
--   never smuggle non-image content types to the <img> tag.
-- ============================================================


ALTER TABLE "app_user"
  ADD COLUMN "avatar_data" text;

ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_avatar_data_check" CHECK (
    "avatar_data" IS NULL
    OR (
      char_length("avatar_data") <= 160000
      AND (
        "avatar_data" LIKE 'data:image/png;base64,%'
        OR "avatar_data" LIKE 'data:image/jpeg;base64,%'
        OR "avatar_data" LIKE 'data:image/webp;base64,%'
      )
    )
  );
