-- ============================================================
-- AeroOps — Slice P2-ESIGN: E-signature on lesson records
-- Migration: 0032_lesson_signature.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0030_documents.sql must already be
--               applied. Independent of 0031_pos_sales.sql (a sibling P2
--               slice; neither migration depends on the other).
--
-- COMPLIANCE (HARD LINE — HIGHEST COMPLIANCE CARE, verbatim) [VERIFY-P2-A]:
-- A lesson_signature is an operator/instructor ATTESTATION artifact — a
-- record of who signed, when, what they attested to, and a content hash of
-- the signed lesson_record snapshot. It is NOT an FAA-recognized digital/
-- electronic signature, NOT a §61.51 / §61.65 / Part-141 endorsement of
-- record, and it computes NO training-completion, stage, graduation, or
-- currency determination of any kind. role_at_signing is a snapshot of the
-- signer's operator role; attestation_text is free-text the operator
-- provides. A stored signature does not verify eligibility, endorsement
-- validity, or airworthiness — a human still makes every regulatory call.
--
-- Deferred forward seams (not built here): cryptographic/PKI signatures, FAA
-- IACRA / 8710 integration, real §61 endorsements, completion-certificate
-- generation, biometric signing, and the append-only stage-check marker
-- (see docs/specs/slice-p2-esign.md §8 — no enrollment column added here).
--
-- Implements P2-ESIGN: an append-only e-signature/attestation artifact on a
-- lesson_record (Training, migration 0012). A signed lesson_record can never
-- be hard-deleted (composite FK ON DELETE RESTRICT).
--
--   lesson_signature — APPEND-ONLY (SELECT + INSERT RLS only, mirrors
--     ledger_entry, migration 0022): who signed, when, what they attested
--     to, and a content_hash (sha256 of canonicalLessonRecordSnapshot,
--     @aeroops/core) of the signed lesson_record snapshot — tamper-evidence,
--     NOT a cryptographic signature. Voiding APPENDS a tombstone row
--     (voided_by_signature_id self-ref) — never an UPDATE/DELETE.
--
-- Key guarantees:
--   (1) lesson_signature is tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS
--       + SELECT + INSERT policies ONLY (mirrors dispatch_ticket_correction /
--       ledger_entry / audit_log / qbo_export_log). GRANT is SELECT + INSERT
--       only; REVOKE UPDATE, DELETE is an explicit belt-and-suspenders
--       backstop. With FORCE ROW LEVEL SECURITY, the absence of an
--       UPDATE/DELETE policy blocks those operations for ALL roles,
--       including the table owner — the structural guarantee that a
--       signature is immutable once inserted.
--   (2) Voiding is expressed as a NEW tombstone row, never an edit. Semantics
--       of voided_by_signature_id:
--         - NULL     → a normal attesting signature (may be ACTIVE or VOIDED).
--         - NON-NULL → this row IS a tombstone that voids the referenced
--           signature; a tombstone can never itself be voided (command-layer
--           refusal, cannot_void_tombstone).
--       A non-tombstone signature is VOIDED iff some tombstone row's
--       voided_by_signature_id references it; otherwise it is ACTIVE.
--   (3) NO partial UNIQUE index enforcing "one active signature per
--       lesson_record". A partial unique WHERE voided_by_signature_id IS
--       NULL would block legitimate re-signing after a void (the original
--       row is a non-tombstone that stays in the table forever — voiding
--       never deletes it). "One active signature" is instead enforced in the
--       COMMAND LAYER (signLessonRecord / voidLessonSignature) under a
--       FOR UPDATE lock on the parent lesson_record row — mirrors the
--       documented "NO flat unique (enrollment_id, lesson_id)" rationale on
--       lesson_record itself (migration 0012).
--   (4) Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--         (org_id) → org(id) ON DELETE CASCADE.
--         (lesson_record_id, org_id) → lesson_record(id, org_id)
--           ON DELETE RESTRICT — a signed lesson record can never be
--           hard-deleted (records integrity).
--         (signer_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
--           — write-once attribution; durable "who" also lives in audit_log.
--         (voided_by_signature_id, org_id) → lesson_signature(id, org_id)
--           ON DELETE RESTRICT — nullable, fires only on non-null; the
--           self-referencing tombstone pointer. Requires
--           lesson_signature_id_org_id_unique (created in this migration).
--   (5) CHECKs: role_at_signing / attestation_text / content_hash must all be
--       non-empty after btrim.
--   (6) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables; also the self-FK target.
--   (7) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the one new table is created.
--
-- ORDER within this file:
--   (1) CREATE TABLE lesson_signature (FKs + CHECKs + UNIQUE)
--   (2) Indexes
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (SELECT + INSERT only)
--   (5) GRANT SELECT, INSERT + REVOKE UPDATE, DELETE
-- ============================================================


-- ── (1) TABLE lesson_signature ──────────────────────────────────────────────

CREATE TABLE "lesson_signature" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"                 uuid NOT NULL,
  "lesson_record_id"       uuid NOT NULL,
  "signer_user_id"         uuid NOT NULL,
  "role_at_signing"        text NOT NULL,
  "attestation_text"       text NOT NULL,
  "content_hash"           text NOT NULL,
  "voided_by_signature_id" uuid,
  "signed_at"              timestamptz NOT NULL DEFAULT now(),
  "created_at"             timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "lesson_signature_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: signature must reference a lesson_record in the same org.
  -- ON DELETE RESTRICT: a signed lesson record can never be hard-deleted.
  -- Targets lesson_record_id_org_id_unique (migration 0012).
  CONSTRAINT "lesson_signature_record_org_fk"
    FOREIGN KEY ("lesson_record_id", "org_id")
    REFERENCES "lesson_record"("id", "org_id") ON DELETE RESTRICT,

  -- Composite FK: the signer must be a member of the same org. Write-once
  -- attribution — durable "who" also lives in audit_log.
  -- Targets app_user_id_org_id_unique (migration 0000).
  CONSTRAINT "lesson_signature_signer_org_fk"
    FOREIGN KEY ("signer_user_id", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- Composite candidate key — consistent with all other tenant tables; also
  -- the self-FK target for voided_by_signature_id (below).
  CONSTRAINT "lesson_signature_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- Self-referencing composite FK: when present, the tombstone's voided
  -- target must be a signature in the same org.
  -- ON DELETE RESTRICT: a tombstone's target can never be hard-deleted.
  -- Targets lesson_signature_id_org_id_unique (above, same table).
  CONSTRAINT "lesson_signature_voids_org_fk"
    FOREIGN KEY ("voided_by_signature_id", "org_id")
    REFERENCES "lesson_signature"("id", "org_id") ON DELETE RESTRICT,

  -- role_at_signing must not be empty (or blank-only).
  CONSTRAINT "lesson_signature_role_nonempty_check" CHECK (
    char_length(btrim("role_at_signing")) > 0
  ),

  -- attestation_text must not be empty (or blank-only).
  CONSTRAINT "lesson_signature_attestation_nonempty_check" CHECK (
    char_length(btrim("attestation_text")) > 0
  ),

  -- content_hash must not be empty (or blank-only).
  CONSTRAINT "lesson_signature_content_hash_nonempty_check" CHECK (
    char_length(btrim("content_hash")) > 0
  )
);


-- ── (2) Indexes ──────────────────────────────────────────────────────────────

-- Covers: getLessonSignatures per-record read.
-- e.g. WHERE org_id=$1 AND lesson_record_id=$2
CREATE INDEX "lesson_signature_org_record_idx"
  ON "lesson_signature" ("org_id", "lesson_record_id");

-- Covers: resolving tombstone → voided target.
-- e.g. WHERE org_id=$1 AND voided_by_signature_id=$2
CREATE INDEX "lesson_signature_org_voids_idx"
  ON "lesson_signature" ("org_id", "voided_by_signature_id");


-- ── (3) ENABLE + FORCE RLS ───────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "lesson_signature" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "lesson_signature" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies — APPEND-ONLY (SELECT + INSERT only) ───────────────────
-- Mirrors ledger_entry (0022) / dispatch_ticket_correction (0018) /
-- qbo_export_log (0021) / audit_log exactly: no UPDATE or DELETE policy.
-- With FORCE ROW LEVEL SECURITY, the absence of a permissive policy blocks
-- those operations for ALL roles, including the table owner — the structural
-- guarantee that a signature is immutable once inserted. Corrections are new
-- tombstone rows, never edits.
--
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

CREATE POLICY "lesson_signature_select"
  ON "lesson_signature"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "lesson_signature_insert"
  ON "lesson_signature"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app ─────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT ON "lesson_signature" TO aeroops_app;
REVOKE UPDATE, DELETE ON "lesson_signature" FROM aeroops_app;
