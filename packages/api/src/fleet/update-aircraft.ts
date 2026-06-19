/**
 * update-aircraft.ts — Aircraft identity edit (Slice 5.2).
 *
 * updateAircraft — edits aircraft identity fields (make/model/year/serialNumber/
 * homeBaseLocationId/hasHobbs/hasTach/displayName). NEVER touches tailNumber,
 * kind, active, meters, or dispatch/squawk/grounding records.
 *
 * GUARANTEES:
 *   - requireCapability('fleet:manage') FIRST.
 *   - org_id from session only; cross-org/invisible id → not_found.
 *   - kind !== 'aircraft' → not_found.
 *   - homeBaseLocationId: pre-check it is a visible same-org location (else
 *     invalid_home_base); if null → clear home base (SET NULL in app code).
 *   - year validated: 1900–2200 range (ValidationError if out-of-range).
 *   - ONE audit_log row 'aircraft.updated' per call, with before/after of
 *     identity fields (the frozen write-once/append-only records are untouched).
 *   - Returns fresh AircraftDetail via getAircraftDetailWithDb (same tx scope).
 *
 * TWO CALLING FORMS:
 *   updateAircraft(session, input)          — app code.
 *   updateAircraftWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { resource, auditLog, location } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { UpdateAircraftResult } from './types.js';
import { assembleAircraftDetail } from './internal.js';

// ─── UUID pattern ─────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const updateAircraftInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  // Editable identity fields (all optional — only provided fields are updated).
  displayName:         z.string().min(1).optional(),
  make:                z.string().nullable().optional(),
  model:               z.string().nullable().optional(),
  year:                z.number().int().min(1900).max(2200).nullable().optional(),
  serialNumber:        z.string().nullable().optional(),
  homeBaseLocationId:  z.string().regex(UUID_RE).nullable().optional(),
  hasHobbs:            z.boolean().optional(),
  hasTach:             z.boolean().optional(),
});

export type UpdateAircraftInput = z.infer<typeof updateAircraftInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _updateAircraftImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateAircraftResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'fleet:manage');

  // 2. VALIDATE input.
  const parsed = updateAircraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[fleet] invalid updateAircraft input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load target aircraft (RLS-scoped; cross-org/unknown → 0 rows → not_found).
    const existing = await tx
      .select({
        id: resource.id,
        orgId: resource.orgId,
        kind: resource.kind,
        displayName: resource.displayName,
        tailNumber: resource.tailNumber,
        make: resource.make,
        model: resource.model,
        year: resource.year,
        serialNumber: resource.serialNumber,
        homeBaseLocationId: resource.homeBaseLocationId,
        hasHobbs: resource.hasHobbs,
        hasTach: resource.hasTach,
        active: resource.active,
      })
      .from(resource)
      .where(eq(resource.id, input.resourceId))
      .limit(1);

    const current = existing[0];
    if (!current || current.kind !== 'aircraft') {
      return { ok: false, reason: 'not_found' };
    }

    // 4. Pre-check homeBaseLocationId if provided (not-undefined, not null).
    if (input.homeBaseLocationId !== undefined && input.homeBaseLocationId !== null) {
      const locRows = await tx
        .select({ id: location.id })
        .from(location)
        .where(eq(location.id, input.homeBaseLocationId))
        .limit(1);
      if (locRows.length === 0) {
        // Not visible in org context (cross-org or non-existent).
        return { ok: false, reason: 'invalid_home_base' };
      }
    }

    // 5. Build update payload (only changed fields).
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.displayName !== undefined)        updates['displayName']        = input.displayName;
    if (input.make !== undefined)               updates['make']               = input.make;
    if (input.model !== undefined)              updates['model']              = input.model;
    if (input.year !== undefined)               updates['year']               = input.year;
    if (input.serialNumber !== undefined)       updates['serialNumber']       = input.serialNumber;
    if (input.homeBaseLocationId !== undefined) updates['homeBaseLocationId'] = input.homeBaseLocationId;
    if (input.hasHobbs !== undefined)           updates['hasHobbs']           = input.hasHobbs;
    if (input.hasTach !== undefined)            updates['hasTach']            = input.hasTach;

    // 6. Apply update.
    await tx
      .update(resource)
      .set(updates)
      .where(eq(resource.id, input.resourceId));

    // 7. ONE audit row — before/after of identity fields.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'aircraft.updated',
      entityType: 'resource',
      entityId: input.resourceId,
      metadata: {
        before: {
          displayName:        current.displayName,
          make:               current.make,
          model:              current.model,
          year:               current.year,
          serialNumber:       current.serialNumber,
          homeBaseLocationId: current.homeBaseLocationId,
          hasHobbs:           current.hasHobbs,
          hasTach:            current.hasTach,
        },
        after: {
          displayName:        input.displayName        ?? current.displayName,
          make:               input.make               !== undefined ? input.make        : current.make,
          model:              input.model              !== undefined ? input.model       : current.model,
          year:               input.year               !== undefined ? input.year        : current.year,
          serialNumber:       input.serialNumber       !== undefined ? input.serialNumber : current.serialNumber,
          homeBaseLocationId: input.homeBaseLocationId !== undefined ? input.homeBaseLocationId : current.homeBaseLocationId,
          hasHobbs:           input.hasHobbs           ?? current.hasHobbs,
          hasTach:            input.hasTach            ?? current.hasTach,
        },
      },
    });

    // 8. Return fresh detail by re-reading all facets via shared helper
    //    (same queries, same limits, same null-meter rule as getAircraftDetail).
    const aircraft = await assembleAircraftDetail(tx, input.resourceId);
    if (!aircraft) throw new Error('[fleet] updateAircraft: identity re-read returned no row');

    return { ok: true, aircraft };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function updateAircraft(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateAircraftResult> {
  const db = await getDb();
  return _updateAircraftImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function updateAircraftWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateAircraftResult> {
  return _updateAircraftImpl(db, session, input);
}
