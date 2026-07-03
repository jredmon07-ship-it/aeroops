/**
 * create-maintenance-item.ts — createMaintenanceItem write path (Slice P1.5).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order') BEFORE any
 *     data access (reuses the existing "operator maintenance-write" cap —
 *     owner/manager/dispatcher/mechanic; NOT cfi/accountant/renter/student —
 *     no new capability added for this slice).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data, INCLUDING
 *     the track_by/meter_basis/dueValueHours/dueDate shape invariant (the DB
 *     CHECK is the backstop, not the sole guard — mirrors resource_kind_shape_check).
 *   - resource must be visible/active/kind='aircraft' in org; else ValidationError.
 *   - INSERT active=true, created_by=session.userId + audit
 *     'maintenance_item.created'.
 *   - NO computed FAA/Part-43/91.409 determination — OPERATOR-ENTERED
 *     tracking thresholds only. [VERIFY-P1.5-A]
 *
 * TWO CALLING FORMS:
 *   createMaintenanceItem(session, input)        — app code; uses getDb() internally.
 *   createMaintenanceItemWithDb(db, session, in) — tests; inject pglite client.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { maintenanceItem, auditLog, resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { MAINTENANCE_TRACK_BY, METER_BASIS } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toMaintenanceItemView } from './internal.js';
import type { CreateMaintenanceItemResult } from './maintenance-item-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Input schema ─────────────────────────────────────────────────────────────
//
// The track_by/meter_basis/dueValueHours/dueDate shape invariant is enforced
// here via .superRefine (app-code backstop before the DB CHECK).

const createMaintenanceItemInputSchema = z
  .object({
    resourceId:         z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
    title:               z.string().trim().min(1, { message: 'title must not be empty' }),
    trackBy:             z.enum(MAINTENANCE_TRACK_BY),
    meterBasis:          z.enum(METER_BASIS).optional(),
    dueValueHours:       z.number().nonnegative().finite().optional(),
    dueDate:             z.string().regex(ISO_DATE_RE, { message: 'dueDate must be YYYY-MM-DD' }).optional(),
    warnThresholdHours:  z.number().nonnegative().finite().optional(),
    warnLeadDays:        z.number().int().nonnegative().optional(),
    notes:               z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.trackBy === 'hours') {
      if (val.meterBasis === undefined) {
        ctx.addIssue({ code: 'custom', message: 'meterBasis is required when trackBy is "hours"' });
      }
      if (val.dueValueHours === undefined) {
        ctx.addIssue({ code: 'custom', message: 'dueValueHours is required when trackBy is "hours"' });
      }
      if (val.dueDate !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'dueDate must not be set when trackBy is "hours"' });
      }
    } else {
      if (val.meterBasis !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'meterBasis must not be set when trackBy is "date"' });
      }
      if (val.dueValueHours !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'dueValueHours must not be set when trackBy is "date"' });
      }
      if (val.dueDate === undefined) {
        ctx.addIssue({ code: 'custom', message: 'dueDate is required when trackBy is "date"' });
      }
    }
  });

export type CreateMaintenanceItemInput = z.infer<typeof createMaintenanceItemInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _createMaintenanceItemImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateMaintenanceItemResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = createMaintenanceItemInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid createMaintenanceItem input: ${first?.message ?? 'unknown'}`,
    );
  }
  const {
    resourceId, title, trackBy, meterBasis, dueValueHours, dueDate,
    warnThresholdHours, warnLeadDays, notes,
  } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3a. Verify resource visible/active/aircraft.
    const resRows = await tx
      .select({ id: resource.id, kind: resource.kind, active: resource.active })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1);

    const res = resRows[0];
    if (!res) {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} not found in this org.`,
      );
    }
    if (!res.active) {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} is inactive.`,
      );
    }
    if (res.kind !== 'aircraft') {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} has kind '${res.kind}'; maintenance items are for aircraft only.`,
      );
    }

    // 3b. INSERT maintenance item, active=true.
    const [inserted] = await tx
      .insert(maintenanceItem)
      .values({
        orgId:              sess.orgId,
        resourceId,
        title,
        trackBy,
        meterBasis:         meterBasis ?? null,
        dueValueHours:      dueValueHours !== undefined ? String(dueValueHours) : null,
        dueDate:            dueDate ?? null,
        warnThresholdHours: warnThresholdHours !== undefined ? String(warnThresholdHours) : null,
        warnLeadDays:       warnLeadDays ?? null,
        notes:              notes ?? null,
        active:             true,
        createdBy:          sess.userId,
      })
      .returning();

    // 3c. Audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'maintenance_item.created',
      entityType:  'maintenance_item',
      entityId:    inserted!.id,
      metadata: {
        resourceId,
        title,
        trackBy,
        meterBasis: meterBasis ?? null,
        dueValueHours: dueValueHours ?? null,
        dueDate: dueDate ?? null,
      },
    });

    return { ok: true, item: toMaintenanceItemView(inserted!) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function createMaintenanceItem(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateMaintenanceItemResult> {
  const db = await getDb();
  return _createMaintenanceItemImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function createMaintenanceItemWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateMaintenanceItemResult> {
  return _createMaintenanceItemImpl(db, session, input);
}
