/**
 * qbo_connection — one OAuth2 connection per org to the operator's own
 * QuickBooks Online company file (realm).
 *
 * Operator bookkeeping-export infrastructure. NO Stripe, NO card/bank data,
 * NO payment processing — this table holds an OAuth2 access/refresh token
 * pair used ONLY to push existing invoice records into QBO.
 *
 * Tenant-scoped: carries org_id, gets RLS ENABLE + FORCE (ADR-0001 invariant).
 * org_id is UNIQUE — exactly one QBO connection per org.
 *
 * [VERIFY-QB1-SEC-1]: access_token/refresh_token are stored as PLAINTEXT TEXT
 * columns in this slice. Encryption-at-rest (e.g. pgcrypto column encryption
 * or an application-level envelope) is a FLAGGED FOLLOW-UP before this table
 * holds real operator credentials in production. RLS + the non-superuser
 * aeroops_app role are the only protections here.
 *
 * status: 'connected' | 'disconnected' | 'error'. disconnectQbo nulls both
 * token columns and sets status='disconnected' (never hard-deletes the row —
 * the connection row is the durable record of "has this org ever connected").
 *
 * ── Composite FKs (hand-written in migration 0021 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [qbo_connection_org_id_fk]
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const qboConnection = pgTable(
  'qbo_connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),

    // The QBO company file id this org is connected to. Null until connected.
    realmId: text('realm_id'),

    // [VERIFY-QB1-SEC-1]: plaintext — encryption-at-rest is a flagged follow-up.
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),

    // qbo_connection_status_check: 'connected' | 'disconnected' | 'error'.
    status: text('status').notNull().default('disconnected'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one QBO connection per org.
    uniqueIndex('qbo_connection_org_id_unique').on(t.orgId),
    // Composite candidate key — consistent with all other tenant tables.
    uniqueIndex('qbo_connection_id_org_id_unique').on(t.id, t.orgId),
  ],
);

export type QboConnectionSelect = typeof qboConnection.$inferSelect;
export type QboConnectionInsert = typeof qboConnection.$inferInsert;
