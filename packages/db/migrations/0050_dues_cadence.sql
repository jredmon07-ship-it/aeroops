-- ============================================================
-- AeroOps — Dues/tuition cadence: monthly → also quarterly/semiannual/annual
-- Migration: 0050_dues_cadence.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0049_signup_terms_acceptance.sql must
--               already be applied.
--
-- CONTEXT: the recurring-dues engine (migration 0025) locked cadence to
-- 'monthly'. Clubs commonly bill ANNUAL dues; schools bill per-SEMESTER (twice
-- a year) or monthly tuition. This widens the cadence domain and adds an
-- anchor_month so a non-monthly schedule knows WHICH month(s) of the year it
-- bills.
--
--   cadence: 'monthly' | 'quarterly' | 'semiannual' | 'annual'
--   anchor_month: 1–12, the month a non-monthly cycle anchors on. NULL for
--     monthly (which bills every month). A schedule is "due" in calendar month
--     M iff (M - anchor_month) is a whole multiple of the cadence interval
--     (1 / 3 / 6 / 12) — the pure isDuesScheduleDue helper. The billed
--     period_key stays "YYYY-MM" (the calendar month it bills), so the
--     generation + idempotency machinery (dues_run) is UNCHANGED, and a
--     'monthly' schedule bills exactly as it did before this migration.
--
-- Key guarantees:
--   (a) STRICTLY ADDITIVE — widen one CHECK domain + add one nullable column
--       (no DEFAULT needed; NULL = monthly-style "every period"). No table is
--       created/dropped; existing 'monthly' rows keep billing identically.
--   (b) GRACEFUL ABSENCE: until applied, anchor_month does not exist and
--       cadence is still 'monthly'-only. Every consumer probes for the column
--       (information_schema) and, when absent, treats all schedules as monthly
--       — byte-identical to the pre-0050 world; non-monthly create is refused.
--   (c) INTEGER CENTS untouched. NO charge logic changes here — only WHICH
--       calendar months a draft invoice is generated in.
--
-- ORDER within this file:
--   (1) Widen dues_schedule_cadence_check
--   (2) ADD COLUMN anchor_month + its range CHECK
-- ============================================================


-- ── (1) Widen the cadence domain ──────────────────────────────────────────────

ALTER TABLE "dues_schedule"
  DROP CONSTRAINT "dues_schedule_cadence_check";

ALTER TABLE "dues_schedule"
  ADD CONSTRAINT "dues_schedule_cadence_check" CHECK (
    "cadence" IN ('monthly', 'quarterly', 'semiannual', 'annual')
  );


-- ── (2) anchor_month ──────────────────────────────────────────────────────────
-- The month (1–12) a non-monthly cycle anchors on. NULL for monthly.
-- A CHECK also guarantees a non-monthly cadence carries an anchor and monthly
-- does not depend on one (monthly ignores it whether NULL or set).

ALTER TABLE "dues_schedule"
  ADD COLUMN "anchor_month" integer;

ALTER TABLE "dues_schedule"
  ADD CONSTRAINT "dues_schedule_anchor_month_range_check" CHECK (
    "anchor_month" IS NULL OR ("anchor_month" BETWEEN 1 AND 12)
  );

ALTER TABLE "dues_schedule"
  ADD CONSTRAINT "dues_schedule_anchor_required_check" CHECK (
    "cadence" = 'monthly' OR "anchor_month" IS NOT NULL
  );
