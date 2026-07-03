-- ============================================================
-- AeroOps — Slice P1.6: Document storage
-- Migration: 0030_documents.sql
--
-- !! HUMAN-GATED — NEVER AUTO-RUN !!
-- This file is staged for human review ONLY.
-- No tooling in this repo executes it automatically.
-- A human must review and run it manually against the
-- target database after explicit sign-off.
--
-- Prerequisites: 0000_loud_prodigy.sql … 0029_maintenance_due.sql
--               must already be applied.
--
-- COMPLIANCE (HARD LINE — matches member_tag / squawk / work_order / lesson_record
-- precedent, verbatim posture): this table stores uploaded-file METADATA (never
-- the file bytes — those live in external object storage, see packages/api/src/
-- storage/provider.ts). A document is STORED, NEVER INTERPRETED: no OCR, no
-- computed FAA/currency/medical-validity/eligibility/airworthiness determination
-- is derived from an uploaded file's contents. `category` is a FREE-TEXT operator
-- label (e.g. "Medical", "Insurance", "POH") — a filing cabinet tab, not a
-- regulatory classification. A stored "Medical" document does NOT mean the
-- operator's software has verified medical currency; a human still makes that
-- call. [VERIFY-P1.6-A]
--
-- Implements P1.6: file uploads attached to either a MEMBER (app_user) or an
-- AIRCRAFT (resource), via pre-signed object-storage URLs — the browser PUTs/
-- GETs directly to storage; the Node server only ever signs URLs and stores
-- metadata rows. NO file bytes ever pass through Postgres or the app server.
--
--   document — one row per uploaded (or in-flight) file.
--     Standard 4-policy mutable RLS (mirrors maintenance_item/rate_schedule):
--     status flips pending→stored via confirmUpload; category is mutable via
--     a future correction path (not built in this slice — no update command
--     exists yet; DELETE via deleteDocument only).
--
-- Key guarantees:
--   (1) document is tenant-scoped: org_id NOT NULL + ENABLE+FORCE RLS + 4
--       fail-closed policies (byte-identical NULLIF predicate) + grants to
--       aeroops_app, mirroring the byte-pattern of 0006/0013/0019/0029 exactly.
--   (2) POLYMORPHIC OWNER — DELIBERATE DESIGN CHOICE, documented deviation:
--       owner_id carries NO foreign key. A document's owner is either an
--       app_user (owner_type='member') or a resource (owner_type='aircraft'),
--       and Postgres cannot express a single FK that targets one of two
--       different tables depending on a sibling column's value. This mirrors
--       the EXISTING polymorphic pattern already established by
--       audit_log.entity_id / qbo_export_log.entity_id (entity_type
--       distinguishes the target table; no FK) — see qbo-export-log.ts /
--       migration 0021 §4 for the precedent this follows exactly.
--       THE GUARANTEE instead lives in the COMMAND LAYER (packages/api/src/
--       documents/internal.ts resolveDocumentOwner): every write path
--       (requestUpload) verifies, INSIDE the org-RLS-scoped transaction, that
--       owner_id actually exists in app_user (org-scoped) or resource
--       (org-scoped, kind='aircraft') BEFORE inserting a document row — so a
--       document can never reference a nonexistent or cross-org owner even
--       though the database itself cannot enforce it structurally. Combined
--       with RLS (org_id scoping) and the server-generated, org-prefixed
--       storage_key (see guarantee 4), this is the documented, deliberate
--       trade-off for a two-target polymorphic association.
--   (3) Composite FKs (hand-written; Drizzle cannot express multi-column FKs):
--         (org_id) → org(id) ON DELETE CASCADE.
--         (uploaded_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT —
--           uploader must be a member of the same org; write-once attribution
--           (mirrors maintenance_item.created_by / work_order.opened_by).
--   (4) storage_key IS THE STRUCTURAL TENANT-ISOLATION BACKSTOP for the
--       object-storage side: it is ALWAYS server-generated (packages/api/src/
--       documents/internal.ts generateStorageKey), NEVER accepted from client
--       input, and is ALWAYS prefixed `org/<org_id>/...` using the session's
--       own org_id. One org's signed upload/download URL can therefore never
--       be minted for a key under a different org's prefix — even if an
--       attacker supplied an arbitrary ownerId/filename, the org segment of
--       the key is taken from the verified session, not from the request body.
--       UNIQUE(storage_key): defensive structural guarantee against key reuse
--       (in addition to the key's own randomness — 128 bits from
--       crypto.randomUUID()).
--   (5) NO file bytes anywhere in this table or any other Postgres table —
--       storage_key is a pointer into external object storage only.
--   (6) status: 'pending' until the client confirms the browser-side PUT
--       completed (confirmUpload flips it to 'stored'). A 'pending' row whose
--       upload never completes is an orphaned metadata row pointing at an
--       object that may not exist — acceptable in this slice (no TTL/GC job);
--       DEFERRED forward seam: a periodic sweep of stale 'pending' rows.
--   (7) TEXT + CHECK for owner_type/status (NOT pgEnum) — mirrors
--       maintenance_item.track_by's additive/reversible-value-domain posture.
--   (8) UNIQUE (id, org_id) composite candidate key — consistent with all
--       other tenant tables; forward-compat for any future composite FK.
--   (9) STRICTLY ADDITIVE — no existing tables/columns/constraints modified.
--       Only the one new table is created.
--
-- ORDER within this file:
--   (1) CREATE TABLE document (FKs + CHECKs + UNIQUE)
--   (2) Indexes
--   (3) ENABLE + FORCE RLS
--   (4) RLS policies (standard 4-policy pattern)
--   (5) GRANT to aeroops_app
-- ============================================================


-- ── (1) TABLE document ──────────────────────────────────────────────────────

CREATE TABLE "document" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"        uuid NOT NULL,
  "owner_type"    text NOT NULL,
  "owner_id"      uuid NOT NULL,
  "storage_key"   text NOT NULL,
  "filename"      text NOT NULL,
  "content_type"  text NOT NULL,
  "size_bytes"    bigint NOT NULL,
  "category"      text,
  "status"        text NOT NULL DEFAULT 'pending',
  "uploaded_by"   uuid NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),

  -- Tenant spine FK.
  CONSTRAINT "document_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE,

  -- Composite FK: uploader must be a member of the same org. Write-once
  -- attribution (mirrors maintenance_item_created_by_org_fk).
  -- Requires app_user(id, org_id) UNIQUE "app_user_id_org_id_unique"
  -- established in migration 0000.
  CONSTRAINT "document_uploaded_by_org_fk"
    FOREIGN KEY ("uploaded_by", "org_id")
    REFERENCES "app_user"("id", "org_id") ON DELETE RESTRICT,

  -- owner_id carries NO foreign key — see guarantee (2) above. Enforced in
  -- the command layer (resolveDocumentOwner), not structurally.

  -- Composite candidate key — consistent with all other tenant tables.
  CONSTRAINT "document_id_org_id_unique"
    UNIQUE ("id", "org_id"),

  -- storage_key is globally unique — the structural backstop on top of its
  -- own randomness (see guarantee 4).
  CONSTRAINT "document_storage_key_unique"
    UNIQUE ("storage_key"),

  -- owner_type value domain.
  CONSTRAINT "document_owner_type_check" CHECK (
    "owner_type" IN ('member', 'aircraft')
  ),

  -- status value domain.
  CONSTRAINT "document_status_check" CHECK (
    "status" IN ('pending', 'stored')
  ),

  -- filename must not be empty (or blank-only).
  CONSTRAINT "document_filename_nonempty_check" CHECK (
    char_length(btrim("filename")) > 0
  ),

  -- storage_key must not be empty (or blank-only) — defensive; the app layer
  -- always generates a non-empty, org-prefixed key.
  CONSTRAINT "document_storage_key_nonempty_check" CHECK (
    char_length(btrim("storage_key")) > 0
  ),

  -- content_type must not be empty (or blank-only).
  CONSTRAINT "document_content_type_nonempty_check" CHECK (
    char_length(btrim("content_type")) > 0
  ),

  -- size_bytes must be positive (a zero/negative-byte "file" is nonsensical).
  CONSTRAINT "document_size_bytes_positive_check" CHECK (
    "size_bytes" > 0
  )
);


-- ── (2) Indexes ──────────────────────────────────────────────────────────────

-- Covers: per-owner document list queries (listDocuments).
-- e.g. WHERE org_id=$1 AND owner_type=$2 AND owner_id=$3
CREATE INDEX "document_org_owner_idx"
  ON "document" ("org_id", "owner_type", "owner_id");


-- ── (3) ENABLE + FORCE RLS ───────────────────────────────────────────────────
-- FORCE is mandatory: PGlite (and any superuser/owner connection) bypasses
-- ENABLE without FORCE. Production must also connect as a non-owner role,
-- but FORCE is the structural backstop.

ALTER TABLE "document" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "document" FORCE   ROW LEVEL SECURITY;


-- ── (4) RLS policies (standard 4-policy pattern) ────────────────────────────
-- Predicate: NULLIF(current_setting('app.current_org_id', true), '')::uuid
--   - current_setting(..., true) = missing_ok → returns NULL when GUC unset
--   - NULLIF converts '' to NULL
--   - NULL = NULL is false in SQL → 0 rows / 0 writes (fail-closed)

CREATE POLICY "document_select"
  ON "document"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "document_insert"
  ON "document"
  FOR INSERT
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "document_update"
  ON "document"
  FOR UPDATE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY "document_delete"
  ON "document"
  FOR DELETE
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );


-- ── (5) GRANT to aeroops_app ─────────────────────────────────────────────────
-- Production MUST connect as this non-superuser role so that FORCE RLS
-- is not bypassed.

GRANT SELECT, INSERT, UPDATE, DELETE ON "document" TO aeroops_app;
