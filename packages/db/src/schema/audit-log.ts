/**
 * audit_log — append-only audit trail.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE.
 *
 * APPEND-ONLY posture: the migration applies only SELECT + INSERT RLS
 * policies (no UPDATE, no DELETE) and FORCE RLS is set so even the
 * table owner cannot silently mutate rows.
 *
 * NO updated_at column — appended rows are immutable by design.
 *
 * Indexes:
 *   - (org_id) — required by all audit queries (the RLS predicate also benefits)
 *   - (org_id, entity_type, entity_id) — supports "show audit trail for
 *     this specific entity" queries
 *
 * actor_user_id is nullable: system-generated events (e.g. scheduled jobs)
 * have no human actor. ON DELETE SET NULL preserves the log entry even when
 * the user is deleted.
 */
import { pgTable, text, uuid, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { org } from './org.js';
import { appUser } from './user.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => appUser.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_org_id_idx').on(t.orgId),
    index('audit_log_org_entity_idx').on(t.orgId, t.entityType, t.entityId),
  ],
);

export type AuditLogSelect = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
