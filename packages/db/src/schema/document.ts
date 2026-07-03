/**
 * document — uploaded-file METADATA attached to a MEMBER (app_user) or an
 * AIRCRAFT (resource). Slice P1.6.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 *
 * COMPLIANCE (HARD LINE — mirrors member_tag.ts / squawk.ts precedent):
 *   A document is STORED, NEVER INTERPRETED. This table (and the rest of the
 *   slice) never derives a computed FAA/currency/medical-validity/eligibility/
 *   airworthiness determination from an uploaded file's contents — no OCR, no
 *   parsing. `category` is a FREE-TEXT operator label (a filing-cabinet tab
 *   like "Medical" or "Insurance"), not a regulatory classification. A human
 *   still makes any compliance call. [VERIFY-P1.6-A]
 *
 * NO file bytes anywhere in this table — storage_key is a pointer into
 * external object storage (see packages/api/src/storage/provider.ts). The
 * app server only ever signs upload/download URLs; the browser PUTs/GETs
 * directly to storage.
 *
 * ── POLYMORPHIC OWNER (deliberate, documented deviation) ─────────────────────
 * owner_id carries NO .references() and NO hand-written composite FK in the
 * migration — a document's owner is either app_user (owner_type='member') or
 * resource (owner_type='aircraft'), and Postgres cannot express one FK that
 * targets a different table depending on a sibling column. This mirrors the
 * EXISTING polymorphic pattern already used by audit_log.entity_id /
 * qbo_export_log.entity_id (entity_type distinguishes the target table; no
 * FK — see qbo-export-log.ts). The guarantee instead lives in the command
 * layer: packages/api/src/documents/internal.ts's resolveDocumentOwner
 * verifies, INSIDE the org-RLS-scoped transaction, that owner_id exists in
 * the correct table AND the correct org BEFORE any document row is inserted.
 *
 * ── TENANT ISOLATION for the object-storage side ──────────────────────────
 * storage_key is ALWAYS server-generated (packages/api/src/documents/
 * internal.ts generateStorageKey) and ALWAYS prefixed `org/<org_id>/...`
 * using the session's own org_id — NEVER accepted from client input. This is
 * the structural guarantee that one org's signed URL can never be minted for
 * a key under a different org's prefix, independent of RLS.
 *
 * Records posture:
 *   org_id / owner_type / owner_id / storage_key / filename / content_type /
 *   size_bytes / uploaded_by are write-once (set at INSERT, never mutated).
 *   status is mutable (requestUpload inserts 'pending'; confirmUpload flips
 *   it to 'stored' once the client confirms the direct-to-storage PUT
 *   completed). category is set at INSERT; no update command mutates it in
 *   this slice (DEFERRED forward seam). No hard-delete-blocking FK exists —
 *   deleteDocument removes the row (see deleteDocument's own header for the
 *   best-effort provider-delete + row-remove ordering).
 *
 * ── Composite FKs (hand-written in migration 0030 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE
 *     Tenant spine — deleting an org cascades to its document metadata rows.
 *
 *   Composite FK (uploaded_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT
 *     Uploader must be a member of the same org; write-once attribution.
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * document_owner_type_check:   owner_type IN ('member','aircraft')
 * document_status_check:       status IN ('pending','stored')
 * document_filename_nonempty_check:     char_length(btrim(filename)) > 0
 * document_storage_key_nonempty_check:  char_length(btrim(storage_key)) > 0
 * document_content_type_nonempty_check: char_length(btrim(content_type)) > 0
 * document_size_bytes_positive_check:   size_bytes > 0
 *
 * ── UNIQUE ────────────────────────────────────────────────────────────────────
 * (id, org_id) — composite candidate key, consistent with all other tenant
 *   tables.
 * (storage_key) — globally unique; a structural backstop on top of the key's
 *   own randomness (128 bits from crypto.randomUUID()).
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, owner_type, owner_id) — covers per-owner document list queries
 *   (listDocuments): WHERE org_id=$1 AND owner_type=$2 AND owner_id=$3
 */
import {
  pgTable,
  uuid,
  timestamp,
  text,
  bigint,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const document = pgTable(
  'document',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — composite FK (org_id) → org(id) CASCADE is hand-written
    // in migration 0030. The simple .references() here covers Drizzle-level
    // ergonomics; the hand-written FK provides named-constraint auditability.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // 'member' | 'aircraft'. TEXT + CHECK (not a pgEnum) — mirrors
    // maintenance_item.track_by's additive/reversible-value-domain posture.
    // Write-once.
    ownerType: text('owner_type').notNull(),

    // Polymorphic — either an app_user.id (owner_type='member') or a
    // resource.id (owner_type='aircraft'). NO FK — see file header. Verified
    // in the command layer (resolveDocumentOwner) before every INSERT.
    // Write-once.
    ownerId: uuid('owner_id').notNull(),

    // The object-storage key/path (e.g. "org/<org_id>/member/<userId>/<uuid>-<filename>").
    // ALWAYS server-generated — see file header's tenant-isolation guarantee.
    // Write-once. Globally UNIQUE (document_storage_key_unique).
    storageKey: text('storage_key').notNull(),

    // Original client-supplied filename, DISPLAY ONLY (never used to derive
    // the storage path). Write-once.
    filename: text('filename').notNull(),

    // MIME type, validated against an ALLOWLIST at request-upload time
    // (packages/api/src/documents/internal.ts). Write-once.
    contentType: text('content_type').notNull(),

    // File size in bytes, validated against a MAX at request-upload time.
    // bigint (mode:'number') — well within JS safe-integer range for the
    // enforced max (see documents/internal.ts ALLOWED size cap). Write-once.
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),

    // FREE-TEXT operator label (e.g. "Medical", "Insurance", "POH") — a
    // filing-cabinet tab, NOT a computed classification. [VERIFY-P1.6-A]
    // Nullable; set at INSERT only in this slice.
    category: text('category'),

    // 'pending' until confirmUpload flips it to 'stored'. Mutable (the ONE
    // mutable column in this slice).
    status: text('status').notNull().default('pending'),

    // uploadedBy carries no .references() — composite FK
    // (uploaded_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT is
    // hand-written in migration 0030. Write-once.
    uploadedBy: uuid('uploaded_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('document_id_org_id_unique').on(t.id, t.orgId),

    // Globally unique — structural backstop on top of the key's own
    // randomness (mirrors calendar_feed_token_unique).
    uniqueIndex('document_storage_key_unique').on(t.storageKey),

    // Covers: per-owner document list queries.
    // e.g. listDocuments: WHERE org_id=$1 AND owner_type=$2 AND owner_id=$3
    index('document_org_owner_idx').on(t.orgId, t.ownerType, t.ownerId),
  ],
);

export type DocumentSelect = typeof document.$inferSelect;
export type DocumentInsert = typeof document.$inferInsert;
