/**
 * stripe_event — GLOBAL append-only webhook-event dedup ledger.
 *
 * PRIMARY KEY IS event_id (Stripe's own event id, e.g. "evt_..."), NOT a
 * generated uuid — Stripe event ids are globally unique across all Stripe
 * accounts, and the webhook handler's dedup strategy is "INSERT this
 * event_id; a unique-violation means already processed"
 * (idempotent-by-construction, not merely application-checked).
 *
 * org_id is NULLABLE — signature verification happens BEFORE any org lookup,
 * and a webhook delivery must be dedup-able even when its payload cannot yet
 * be associated with an org. When the handler CAN determine the org, org_id
 * is populated for audit/read purposes.
 *
 * payload carries the RAW Stripe event JSON for support/audit — Stripe's own
 * payment-metadata shape (ids, amounts, status), NEVER raw card/bank data.
 *
 * NO updated_at — rows are immutable once inserted (mirrors audit_log).
 *
 * ── Append-only enforcement (migration 0023) ─────────────────────────────────
 * SELECT + INSERT RLS policies ONLY. GRANT SELECT + INSERT; explicit REVOKE
 * UPDATE, DELETE. With FORCE ROW LEVEL SECURITY, the absence of an
 * UPDATE/DELETE policy blocks those operations for ALL roles.
 *
 * ── RLS predicate note (the ONE exception in this schema) ────────────────────
 * Unlike every other tenant table (which fail-closed on an unset/mismatched
 * org GUC), stripe_event's policies additionally admit `org_id IS NULL`
 * (the dedup-only path, before/without an org association). This is
 * documented and isolated to this ONE append-only, no-PII, Stripe-owned-id
 * keyed table — see migration 0023 for the full rationale.
 *
 * ── Composite FKs (hand-written in migration 0023 SQL) ───────────────────────
 *   FK (org_id) → org(id) ON DELETE CASCADE  [stripe_event_org_id_fk] — nullable.
 */
import {
  pgTable,
  text,
  uuid,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { org } from './org.js';

export const stripeEvent = pgTable('stripe_event', {
  // Stripe's own event id IS the primary key — the structural dedup mechanism.
  eventId: text('event_id').primaryKey(),

  // Nullable — see file-level rationale. Composite/simple FK (org_id) →
  // org(id) ON DELETE CASCADE is hand-written in migration 0023 (a plain
  // .references() would force NOT NULL semantics incorrectly here, so it is
  // intentionally omitted at the Drizzle level; the DB-level FK still exists).
  orgId: uuid('org_id').references(() => org.id, { onDelete: 'cascade' }),

  // Stripe event type, e.g. "payment_intent.succeeded".
  type: text('type').notNull(),

  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),

  // Raw Stripe event JSON — ids/amounts/status only, NEVER card/bank data
  // (Stripe itself never includes PAN/CVV/account numbers in webhook payloads).
  payload: jsonb('payload').notNull(),
});

export type StripeEventSelect = typeof stripeEvent.$inferSelect;
export type StripeEventInsert = typeof stripeEvent.$inferInsert;
