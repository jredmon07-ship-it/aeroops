/**
 * lesson_signature — APPEND-ONLY e-signature/attestation artifact on a
 * lesson_record (Slice P2-ESIGN, migration 0032).
 *
 * ── COMPLIANCE HARD LINE (verbatim — [VERIFY-P2-A]) ───────────────────────────
 * A lesson_signature is an operator/instructor ATTESTATION artifact — a record
 * of who signed, when, what they attested to, and a content hash of the signed
 * lesson_record snapshot. It is NOT an FAA-recognized digital/electronic
 * signature, NOT a §61.51 / §61.65 / Part-141 endorsement of record, and it
 * computes NO training-completion, stage, graduation, or currency
 * determination of any kind. role_at_signing is a snapshot of the signer's
 * operator role; attestation_text is free-text the operator provides. A
 * stored signature does not verify eligibility, endorsement validity, or
 * airworthiness — a human still makes every regulatory call.
 *
 * ── Append-only + tombstone-void posture (mirrors ledger_entry, migration 0022) ─
 * There is NO UPDATE/DELETE path for this table, in code or in RLS (migration
 * 0032 applies SELECT + INSERT policies only, with an explicit REVOKE
 * UPDATE, DELETE backstop). A mistake is never edited — it is voided by
 * APPENDING a new tombstone row whose `voided_by_signature_id` points at the
 * signature being voided. Semantics:
 *   - `voided_by_signature_id IS NULL`                        → a normal
 *     attesting signature (may be ACTIVE or VOIDED).
 *   - `voided_by_signature_id IS NOT NULL`                    → this row IS a
 *     tombstone; it can never itself be voided (command-layer refusal).
 *   - A non-tombstone signature is VOIDED iff some tombstone row's
 *     `voided_by_signature_id` references it; otherwise it is ACTIVE.
 * "One active signature per lesson_record" is enforced in the COMMAND LAYER
 * (signLessonRecord) under a `FOR UPDATE` lock on the parent lesson_record row
 * — NOT by a partial UNIQUE index, because that would permanently block
 * legitimate re-signing after a void (the original non-tombstone row stays in
 * the table forever). This mirrors the documented "NO flat unique" rationale
 * on lesson_record itself.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (migration 0032).
 *
 * ── Composite FKs (hand-written in migration 0032 SQL) ───────────────────────
 * Drizzle's .references() cannot express multi-column FKs; all composite FKs
 * are written in the migration and the affected columns carry NO .references().
 *
 *   FK (org_id) → org(id) ON DELETE CASCADE  [lesson_signature_org_id_fk]
 *     Tenant spine.
 *
 *   Composite FK (lesson_record_id, org_id) → lesson_record(id, org_id)
 *     ON DELETE RESTRICT  [lesson_signature_record_org_fk]
 *     A signed lesson record can never be hard-deleted (records integrity).
 *     Targets lesson_record_id_org_id_unique (migration 0012).
 *
 *   Composite FK (signer_user_id, org_id) → app_user(id, org_id)
 *     ON DELETE RESTRICT  [lesson_signature_signer_org_fk]
 *     Write-once attribution — durable "who" also lives in audit_log.
 *     Targets app_user_id_org_id_unique (migration 0000).
 *
 *   Composite FK (voided_by_signature_id, org_id) → lesson_signature(id, org_id)
 *     ON DELETE RESTRICT  [lesson_signature_voids_org_fk]
 *     Nullable; fires only on non-null values. The self-referencing tombstone
 *     pointer. Targets lesson_signature_id_org_id_unique (this migration).
 *
 * ── CHECKs ────────────────────────────────────────────────────────────────────
 * lesson_signature_role_nonempty_check:        char_length(btrim(role_at_signing)) > 0
 * lesson_signature_attestation_nonempty_check:  char_length(btrim(attestation_text)) > 0
 * lesson_signature_content_hash_nonempty_check: char_length(btrim(content_hash)) > 0
 *
 * ── UNIQUE (id, org_id) ──────────────────────────────────────────────────────
 * Composite candidate key — consistent with all other tenant tables; also the
 * self-FK target for voided_by_signature_id.
 *
 * ── Indexes ──────────────────────────────────────────────────────────────────
 * (org_id, lesson_record_id) — per-record signature read (getLessonSignatures).
 * (org_id, voided_by_signature_id) — resolve tombstone → target quickly.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const lessonSignature = pgTable(
  'lesson_signature',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenant spine — simple FK covers Drizzle ergonomics; the named composite FK
    // lesson_signature_org_id_fk is hand-written in migration 0032.
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // lesson_record_id carries no .references() — composite FK
    // (lesson_record_id, org_id) → lesson_record(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0032.
    lessonRecordId: uuid('lesson_record_id').notNull(),

    // signer_user_id carries no .references() — composite FK
    // (signer_user_id, org_id) → app_user(id, org_id) ON DELETE RESTRICT
    // is hand-written in migration 0032. ALWAYS session.userId — never an
    // input the caller may set to another user (see sign-lesson-record.ts).
    signerUserId: uuid('signer_user_id').notNull(),

    // Snapshot of the signer's membership.role AT SIGNING TIME. A later role
    // change never rewrites a past attestation.
    roleAtSigning: text('role_at_signing').notNull(),

    // FREE-TEXT: what the signer attested to. On a tombstone row, this holds
    // the operator-provided void reason instead.
    attestationText: text('attestation_text').notNull(),

    // sha256 hex digest of canonicalLessonRecordSnapshot(@aeroops/core) taken
    // from the lesson_record row at signing/voiding time. TAMPER-EVIDENCE
    // digest only — NOT a cryptographic/PKI signature. [VERIFY-P2-A]
    contentHash: text('content_hash').notNull(),

    // NULL ⇒ a normal attesting signature. NON-NULL ⇒ this row IS a tombstone
    // that voids the referenced signature (self-ref; composite FK hand-written
    // in migration 0032, requires lesson_signature_id_org_id_unique below).
    voidedBySignatureId: uuid('voided_by_signature_id'),

    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all other tenant tables; also
    // the self-FK target for voided_by_signature_id.
    uniqueIndex('lesson_signature_id_org_id_unique').on(t.id, t.orgId),

    // Covers: getLessonSignatures per-record read.
    // e.g. WHERE org_id = $1 AND lesson_record_id = $2
    index('lesson_signature_org_record_idx').on(t.orgId, t.lessonRecordId),

    // Covers: resolving tombstone → voided target.
    // e.g. WHERE org_id = $1 AND voided_by_signature_id = $2
    index('lesson_signature_org_voids_idx').on(t.orgId, t.voidedBySignatureId),
  ],
);

export type LessonSignatureSelect = typeof lessonSignature.$inferSelect;
export type LessonSignatureInsert = typeof lessonSignature.$inferInsert;
