/**
 * list-locations.ts — Location read for the home-base select (Slice 5.2).
 *
 * listLocations — returns all locations for the session org (RLS-scoped),
 * ordered by name. Backs the home-base select in the Edit Aircraft dialog.
 *
 * GUARANTEES:
 *   - requireCapability('fleet:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Never crosses org boundaries.
 *
 * TWO CALLING FORMS:
 *   listLocations(session)          — app code.
 *   listLocationsWithDb(db, session) — tests.
 */
import { asc } from 'drizzle-orm';
import { location } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { LocationOption } from './types.js';

// ─── Shared implementation ────────────────────────────────────────────────────

async function _listLocationsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<LocationOption[]> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'fleet:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const rows = await tx
      .select({
        id:   location.id,
        name: location.name,
        icao: location.icao,
      })
      .from(location)
      .orderBy(asc(location.name));

    return rows.map((r) => ({
      id:   r.id,
      name: r.name,
      icao: r.icao ?? null,
    }));
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function listLocations(
  session: AppSession | null | undefined,
): Promise<LocationOption[]> {
  const db = await getDb();
  return _listLocationsImpl(db, session);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function listLocationsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<LocationOption[]> {
  return _listLocationsImpl(db, session);
}
