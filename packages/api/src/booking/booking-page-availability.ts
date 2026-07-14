/**
 * booking/booking-page-availability.ts — resolveBookingPageAvailability.
 *
 * The public /book/[slug] page render gate (Slice CLUB-MODE follow-up). Mirrors
 * submit-booking-request's resolve-then-module-gate exactly, so the PAGE and the
 * SUBMIT agree: a booking request is offered only when the org is active AND its
 * booking module is on.
 *
 * ANTI-ENUMERATION (ADR-0013): returns a single { available: boolean }. Every
 * not-available reason — unknown slug, suspended org, or booking module turned
 * off — collapses to available:false, indistinguishable from the outside.
 *
 * Graceful absence: with migration 0047 unapplied, loadOrgFeatureState returns
 * all-modules-enabled, so booking stays available (byte-identical to pre-0047).
 *
 * Read-only, unauthenticated (no session): org_id is resolved SERVER-SIDE via
 * resolveOrgBySlug (the sanctioned platform-admin read), NEVER from the caller.
 */

import { withOrgContext } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { resolveOrgBySlug } from '../auth/resolve-org.js';
import { getDb } from '../db.js';
import { loadOrgFeatureState } from '../org-features/org-features-internal.js';

export interface BookingPageAvailability {
  available: boolean;
  /** The org display name, present ONLY when available (nothing leaks otherwise). */
  orgName: string | null;
}

async function _resolveImpl(db: AnyDb, slug: string): Promise<BookingPageAvailability> {
  const org = await resolveOrgBySlug(db, slug);
  if (!org || org.status !== 'active') {
    return { available: false, orgName: null };
  }
  const state = await withOrgContext(db, org.id, (tx) => loadOrgFeatureState(tx as AnyDb, org.id));
  if (!state.features.booking) {
    return { available: false, orgName: null };
  }
  return { available: true, orgName: org.name };
}

export async function resolveBookingPageAvailability(slug: string): Promise<BookingPageAvailability> {
  const db = await getDb();
  return _resolveImpl(db, slug);
}

export async function resolveBookingPageAvailabilityWithDb(
  db: AnyDb,
  slug: string,
): Promise<BookingPageAvailability> {
  return _resolveImpl(db, slug);
}
