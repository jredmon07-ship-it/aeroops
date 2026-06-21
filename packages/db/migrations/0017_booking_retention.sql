-- ============================================================
-- AeroOps — Slice PB-LR.A: Booking-request retention config
-- Migration: 0017_booking_retention.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql + 0001_auth_credential.sql
--               + 0002_scheduling.sql + 0003_booking_policies.sql
--               + 0004_recurrence.sql + 0005_dispatch.sql
--               + 0006_squawks_grounding.sql + 0007_fleet.sql
--               + 0008_people.sql + 0009_dispatch_gate.sql
--               + 0010_civil_twilight.sql + 0011_optimizer_run.sql
--               + 0012_training.sql + 0013_work_orders.sql
--               + 0014_availability.sql + 0015_booking_request.sql
--               + 0016_booking_request_convert.sql
--               must already be applied.
--
-- Adds the Slice PB-LR.A data-model delta:
--   (1) ALTER dispatch_config ADD booking_request_retention_days (int, default 365)
--   (2) ALTER dispatch_config ADD booking_request_retention_includes_converted (bool, default false)
--   (3) ALTER dispatch_config ADD CONSTRAINT dispatch_config_booking_retention_days_check
--         (booking_request_retention_days >= 0 AND booking_request_retention_days <= 3650)
--
-- ── Compliance / data-retention context ───────────────────────────────────────
-- [VERIFY-PB1-COMP-1]: configurable retention + audited hard-delete of stale
-- lead PII. booking_request_retention_days = 0 means "retention disabled /
-- keep forever" — it does NOT mean delete-all. The purge is a per-org,
-- session-scoped, operator-initiated action (NOT a cross-org platform DELETE
-- and NOT an auto-cron). Audit metadata is COUNTS ONLY — the whole point is
-- to remove the PII, so we must never re-log it.
--
-- ── Absent-row defaults ───────────────────────────────────────────────────────
-- No dispatch_config row → the absent-row defaults in loadDispatchConfig apply:
--   { retentionDays: 365, includesConverted: false }
-- These are NOT stored anywhere; they are the application-layer canonical defaults
-- (identical to the DB DEFAULT values below for a newly-created row).
--
-- Key guarantees:
--   (1) Both ALTER TABLE statements are NOT NULL with safe DEFAULT — existing
--       dispatch_config rows receive the defaults without any UPDATE; existing
--       INSERT statements that omit the new columns succeed unchanged (additive).
--   (2) dispatch_config already has ENABLE+FORCE RLS (migration 0009).
--       New columns inherit existing RLS predicates automatically.
--       No new RLS or GRANT needed on dispatch_config.
--   (3) booking_request_retention_days = 0 means "keep forever" (retention OFF),
--       NOT delete-all. The purge command hard-codes a no-op when days = 0.
--   (4) CHECK accepts the full range 0–3650 (0 = keep-forever; 3650 = 10 years).
--       -1 and 3651 are rejected.
--   (5) STRICTLY ADDITIVE — no existing tables, columns, or constraints modified
--       except the two new columns on dispatch_config.
--   (6) NO money column anywhere. NO FAA regulatory data.
--
-- ORDER:
--   (1) ALTER TABLE dispatch_config ADD COLUMN booking_request_retention_days
--   (2) ALTER TABLE dispatch_config ADD COLUMN booking_request_retention_includes_converted
--   (3) ALTER TABLE dispatch_config ADD CONSTRAINT dispatch_config_booking_retention_days_check
-- ============================================================


-- ── (1) Add booking_request_retention_days to dispatch_config ────────────────
-- Number of days to retain booking_request rows after creation.
-- 0 = retention disabled / keep forever (NOT delete-all — the purge command
--   treats days=0 as a no-op). Range: 0–3650 (CHECK in step 3).
-- Default 365: a newly-created row, or a row that omits this column on INSERT,
--   receives a 365-day window. Existing rows are silently updated by Postgres.
-- NOT NULL with DEFAULT: no UPDATE needed; no existing INSERT breaks.
-- dispatch_config already has ENABLE+FORCE RLS (migration 0009); this column
-- inherits the existing RLS predicates automatically. No new RLS or grant needed.

ALTER TABLE "dispatch_config"
  ADD COLUMN "booking_request_retention_days" integer NOT NULL DEFAULT 365;


-- ── (2) Add booking_request_retention_includes_converted to dispatch_config ──
-- When false (default): purge EXCLUDES rows with status='converted'.
--   Converted rows represent genuine customer relationships and should typically
--   be retained longer than speculative leads.
-- When true: the purge window also applies to 'converted' rows.
-- Default false → conservative (excludes converted by default).
-- NOT NULL with DEFAULT: no UPDATE needed; no existing INSERT breaks.

ALTER TABLE "dispatch_config"
  ADD COLUMN "booking_request_retention_includes_converted" boolean NOT NULL DEFAULT false;


-- ── (3) Range CHECK on booking_request_retention_days ────────────────────────
-- Accepts 0–3650 (0 = keep-forever; 3650 ≈ 10 years).
-- Rejects negative values and values above 3650.
-- Mirrors the application-layer zod validation (0–3650 inclusive).

ALTER TABLE "dispatch_config"
  ADD CONSTRAINT "dispatch_config_booking_retention_days_check"
  CHECK ("booking_request_retention_days" >= 0 AND "booking_request_retention_days" <= 3650);
