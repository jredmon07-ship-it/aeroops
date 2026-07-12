-- ============================================================
-- AeroOps — Slice FC-P2: Member expiration reminders (Confirm-Dispatch parity)
-- Migration: 0039_member_expiration.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0038_stage_check_enforcement.sql must
--               already be applied.
--
-- CONTEXT: Flight Circle's "Confirm Dispatch" modal shows pilot medical /
-- document expirations at check-out. AeroOps parity = OPERATOR-ENTERED
-- reminder dates attached to a member (e.g. 'Medical', 'Flight review',
-- 'Rental agreement'), surfaced WARN-ONLY on the member detail page and in
-- the pre-flight checklist of the check-out dialog. Expirations NEVER block
-- dispatch — the FROZEN openDispatch gate (grounded → ineligible → balance)
-- is untouched by this slice.
--
-- COMPLIANCE (HARD LINE) [VERIFY-FC-P2-A]: member_expiration rows are
-- OPERATOR-ENTERED REMINDER DATES ONLY. label is FREE TEXT. The system
-- computes NO medical/currency/flight-review/Part-61/141/legal validity
-- DETERMINATION from these dates — "expired"/"due soon" is pure date
-- arithmetic on an operator-entered reminder. Verifying actual validity
-- remains the operator's and pilot's responsibility.
--
-- Key guarantees:
--   (1) Tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + the standard
--       current_org_id GUC predicate.
--   (2) MUTABLE ONLY via active-flip soft-deactivate: RLS policies are
--       SELECT + INSERT + UPDATE (no DELETE policy; DELETE explicitly
--       REVOKED — mirrors import_row's no-DELETE posture). A mistaken
--       expiration is deactivated, never hard-deleted, preserving the
--       operator's reminder history.
--   (3) Composite FKs (hand-written; Drizzle cannot express multi-column
--       FKs), targeting app_user_id_org_id_unique (migration 0000):
--         (org_id) → org(id) ON DELETE CASCADE.
--         (member_user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE —
--           reminder rows are disposable operator reminders, not audited
--           records (mirrors member_tag_user_org_fk).
--         (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--           attribution preserved (mirrors member_tag_created_by_org_fk).
--   (4) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables.
--   (5) label is non-empty (trimmed) with a sane length cap (<= 100 chars);
--       note (optional) capped at 1000 chars — CHECK constraints. FREE TEXT
--       ONLY — no enumerated regulatory categories.
--   (6) expires_on is a DATE (calendar date, no time/timezone component) —
--       handled end-to-end as a 'YYYY-MM-DD' string; NO timezone math.
--   (7) STRICTLY ADDITIVE — no existing table/column/constraint is touched.
--       The FROZEN dispatch gate and every other engine are untouched.
--       NO money moves here; no Stripe, no card/bank data.
--
-- ORDER within this file:
--   (1) CREATE TABLE member_expiration (FKs + CHECKs)
--   (2) Indexes
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (SELECT + INSERT + UPDATE — no DELETE)
--   (5) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE member_expiration ───────────────────────────────────────────────

CREATE TABLE "member_expiration" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"          uuid NOT NULL,
  "member_user_id"  uuid NOT NULL,
  "label"           text NOT NULL,
  "expires_on"      date NOT NULL,
  "note"            text,
  "active"          boolean NOT NULL DEFAULT true,
  "created_by"      uuid NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "member_expiration_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: the expiration must reference a user in the same org.
  -- ON DELETE CASCADE: operator reminder rows are disposable, not audited
  -- records (mirrors member_tag_user_org_fk).
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "member_expiration_member_user_org_fk"
    FOREIGN KEY ("member_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE CASCADE,

  -- Composite FK: creator must be a user in the same org.
  -- ON DELETE RESTRICT: preserves attribution (mirrors member_tag_created_by_org_fk).
  CONSTRAINT "member_expiration_created_by_org_fk"
    FOREIGN KEY ("created_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "member_expiration_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Non-empty, sanely-bounded FREE-TEXT label (e.g. 'Medical',
  -- 'Flight review', 'Rental agreement'). UI trims before sending.
  CONSTRAINT "member_expiration_label_check" CHECK (
    char_length(btrim("label")) > 0 AND char_length("label") <= 100
  ),

  -- Optional operator note, sanely bounded.
  CONSTRAINT "member_expiration_note_check" CHECK (
    "note" IS NULL OR char_length("note") <= 1000
  )
);


-- ── (2) Indexes ───────────────────────────────────────────────────────────────

-- Per-member expiration listing: WHERE org_id = $1 AND member_user_id = $2.
CREATE INDEX "member_expiration_org_member_idx"
  ON "member_expiration" ("org_id", "member_user_id");

-- Org-wide expiring-soon scan: WHERE org_id = $1 AND active AND expires_on <= $2.
CREATE INDEX "member_expiration_org_expires_idx"
  ON "member_expiration" ("org_id", "expires_on")
  WHERE "active";


-- ── (3) ENABLE + FORCE RLS ────────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "member_expiration" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "member_expiration" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies — SELECT + INSERT + UPDATE (no DELETE) ───────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)
--
-- No DELETE policy: the only sanctioned mutation after INSERT is the
-- active=false soft-deactivate (UPDATE). With FORCE ROW LEVEL SECURITY, the
-- absence of a permissive DELETE policy blocks hard-deletes for ALL roles,
-- including the table owner (mirrors import_row's no-DELETE posture).

CREATE POLICY "member_expiration_select"
  ON "member_expiration"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "member_expiration_insert"
  ON "member_expiration"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "member_expiration_update"
  ON "member_expiration"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app ──────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE ON "member_expiration" TO aeroops_app;
REVOKE DELETE ON "member_expiration" FROM aeroops_app;
