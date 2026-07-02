/**
 * qbo_export_log — append-only push-attempt history to QuickBooks Online.
 *
 * One row per push ATTEMPT (not per entity) — a retried export after an
 * error is a NEW row, never an edit of the failed one, so the full attempt
 * history is preserved. Mirrors dispatch_ticket_correction / audit_log's
 * append-only posture: SELECT + INSERT RLS policies ONLY (no UPDATE/DELETE
 * policy — migration 0021 also REVOKEs UPDATE/DELETE from aeroops_app as a
 * belt-and-suspenders backstop).
 *
 * entity_id carries NO foreign key — polymorphic. entity_type distinguishes
 * 'invoice' rows (entity_id references invoice.id) from 'customer' rows
 * (entity_id references app_user.id, the AeroOps member being pushed as a
 * QBO Customer). Mirrors audit_log.entity_id exactly.
 *
 * Idempotency: a partial UNIQUE index on (org_id, entity_type, entity_id)
 * WHERE status = 'exported' (migration 0021) means an entity can be marked
 * 'exported' at MOST ONCE per org — the structural backstop behind the
 * command layer's idempotency check.
 *
 * NO card/bank data, NO Stripe, NO payment. Records a bookkeeping export
 * of existing operator invoice records only.
 *
 * ── Composite FKs (hand-written in migration 0021 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [qbo_export_log_org_id_fk]
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

export const qboExportLog = pgTable(
  'qbo_export_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // qbo_export_log_entity_type_check: 'invoice' | 'customer'. No FK (polymorphic).
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),

    // The QBO-side id once exported (Invoice.Id / Customer.Id). Null until success.
    qboId: text('qbo_id'),

    // qbo_export_log_status_check: 'pending' | 'exported' | 'error'.
    status: text('status').notNull().default('pending'),

    // Populated on status='error'. Never contains requester/card/bank data —
    // provider error text only (e.g. HTTP status + QBO Fault message).
    errorDetail: text('error_detail'),

    exportedAt: timestamp('exported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('qbo_export_log_id_org_id_unique').on(t.id, t.orgId),

    // Covers: recent-history reads (getQboStatus: last 20 rows).
    index('qbo_export_log_org_created_idx').on(t.orgId, t.createdAt),

    // Covers: idempotency probe + per-entity history.
    index('qbo_export_log_org_entity_idx').on(t.orgId, t.entityType, t.entityId),

    // NOTE: the partial UNIQUE index (org_id, entity_type, entity_id)
    // WHERE (status='exported') that enforces "exported at most once" is
    // hand-written in migration 0021 (Drizzle cannot express partial
    // indexes in table config) — mirrors the dispatch_ticket convention.
  ],
);

export type QboExportLogSelect = typeof qboExportLog.$inferSelect;
export type QboExportLogInsert = typeof qboExportLog.$inferInsert;
