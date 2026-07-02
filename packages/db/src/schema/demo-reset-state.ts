/**
 * demo_reset_state — throttle bookkeeping for the public-demo "reset-on-open"
 * feature (migration 0020; logic in packages/api/src/demo/reset.ts).
 *
 * DEMO INFRASTRUCTURE — NOT a tenant table:
 *   - No org_id; NOT enrolled in RLS.
 *   - Written ONLY by the privileged demo-owner connection
 *     (AEROOPS_DEMO_OWNER_URL). The runtime aeroops_app role is never
 *     granted access (see the REVOKE in the migration).
 *
 * One row per demo slug records when that demo tenant was last wiped and
 * re-seeded, so the reset logic can enforce a minimum interval between resets
 * (default 60s) and skip when the window has not elapsed.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const demoResetState = pgTable('demo_reset_state', {
  slug: text('slug').primaryKey(),
  lastResetAt: timestamp('last_reset_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DemoResetStateSelect = typeof demoResetState.$inferSelect;
export type DemoResetStateInsert = typeof demoResetState.$inferInsert;
