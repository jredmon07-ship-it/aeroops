/**
 * location-commands.ts — Create / edit a base location (airport) for the org.
 *
 * These are the FIRST self-serve writes to the `location` table (previously only
 * seed/tests wrote it). They back the onboarding "base airport" step AND the
 * civil-twilight (day/night) scheduling calc, which needs a location with
 * coordinates. The `location` table already permits org-scoped INSERT/UPDATE
 * (RLS policies location_insert / location_update + aeroops_app DML grants,
 * migration 0000) — NO migration is required.
 *
 * OPERATOR DATA, NOT AN FAA DETERMINATION: latitude/longitude are operator-entered
 * coordinates that improve day/night scheduling accuracy. They are never an
 * airworthiness, currency, or night-currency (§61.57) determination.
 *
 * GUARANTEES (both commands):
 *   - requireCapability('fleet:manage') FIRST (owner/manager/dispatcher/mechanic;
 *     matches the location schema doc "Editable only by fleet:manage cap").
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Coordinates validated as a MATCHED PAIR: both present (numbers) or neither.
 *     latitude ∈ [-90, 90]; longitude ∈ [-180, 180]. A lone lat or lon → refused.
 *   - ICAO uppercased + length-checked (3–4 alphanumeric), or null to clear.
 *   - ONE audit_log row per call ('location.created' / 'location.updated').
 *   - Money-free; no dispatch/meter path touched.
 *
 * TWO CALLING FORMS each:
 *   createLocation(session, input)          / createLocationWithDb(db, session, input)
 *   updateLocation(session, input)          / updateLocationWithDb(db, session, input)
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { location, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type {
  LocationOption,
  CreateLocationResult,
  UpdateLocationResult,
} from './types.js';

// ─── UUID pattern ─────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Shared field schemas ─────────────────────────────────────────────────────

/** ICAO/FAA identifier — 3–4 alphanumeric, normalized to uppercase. */
const icaoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{3,4}$/, {
    message: 'ICAO must be 3–4 letters or digits (e.g. KOSU)',
  })
  .transform((s) => s.toUpperCase());

const latitudeSchema = z
  .number()
  .min(-90, { message: 'latitude must be between -90 and 90' })
  .max(90, { message: 'latitude must be between -90 and 90' });

const longitudeSchema = z
  .number()
  .min(-180, { message: 'longitude must be between -180 and 180' })
  .max(180, { message: 'longitude must be between -180 and 180' });

/** Coordinates must be a matched pair: both numbers, or neither. */
function coordsPaired(d: { latitude?: unknown; longitude?: unknown }): boolean {
  const latNum = typeof d.latitude === 'number';
  const lonNum = typeof d.longitude === 'number';
  return latNum === lonNum;
}
const COORDS_PAIRED_MSG =
  'latitude and longitude must be provided together (or both left blank)';

// ─── CREATE ───────────────────────────────────────────────────────────────────

const createLocationInputSchema = z
  .object({
    name:      z.string().trim().min(1, { message: 'name is required' }).max(120),
    icao:      icaoSchema.optional(),
    latitude:  latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
  })
  .refine(coordsPaired, { message: COORDS_PAIRED_MSG, path: ['longitude'] });

export type CreateLocationInput = z.infer<typeof createLocationInputSchema>;

async function _createLocationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateLocationResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'fleet:manage');

  // 2. VALIDATE.
  const parsed = createLocationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[fleet] invalid createLocation input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const inserted = await tx
      .insert(location)
      .values({
        orgId:     sess.orgId,
        name:      input.name,
        icao:      input.icao ?? null,
        // numeric(8,5) column — the driver expects a string, not a JS number.
        latitude:  input.latitude  != null ? String(input.latitude)  : null,
        longitude: input.longitude != null ? String(input.longitude) : null,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[fleet] createLocation: INSERT returned no rows');

    // ONE audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'location.created',
      entityType:  'location',
      entityId:    row.id,
      metadata: {
        name:      input.name,
        icao:      input.icao ?? null,
        latitude:  input.latitude  ?? null,
        longitude: input.longitude ?? null,
      },
    });

    return { ok: true, location: toLocationOption(row) };
  });
}

export async function createLocation(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateLocationResult> {
  const db = await getDb();
  return _createLocationImpl(db, session, input);
}

export async function createLocationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateLocationResult> {
  return _createLocationImpl(db, session, input);
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

const updateLocationInputSchema = z
  .object({
    locationId: z.string().regex(UUID_RE, { message: 'locationId must be a UUID' }),
    name:       z.string().trim().min(1, { message: 'name must not be empty' }).max(120).optional(),
    // icao: string to set, null to clear, undefined to leave unchanged.
    icao:       icaoSchema.nullable().optional(),
    // Coordinates: both numbers to set, both null to clear, both undefined to
    // leave unchanged. A lone value on either side is refused (coordsPaired).
    latitude:   latitudeSchema.nullable().optional(),
    longitude:  longitudeSchema.nullable().optional(),
  })
  .refine(coordsPaired, { message: COORDS_PAIRED_MSG, path: ['longitude'] });

export type UpdateLocationInput = z.infer<typeof updateLocationInputSchema>;

async function _updateLocationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateLocationResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'fleet:manage');

  // 2. VALIDATE.
  const parsed = updateLocationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[fleet] invalid updateLocation input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load target (RLS-scoped; cross-org/unknown → 0 rows → not_found).
    const existing = await tx
      .select({
        id:        location.id,
        name:      location.name,
        icao:      location.icao,
        latitude:  location.latitude,
        longitude: location.longitude,
      })
      .from(location)
      .where(eq(location.id, input.locationId))
      .limit(1);

    const current = existing[0];
    if (!current) return { ok: false, reason: 'not_found' };

    // 4. Build update payload (only provided fields). Coordinates are written as
    //    a unit — both keys present or both absent — so the DB paired CHECK holds.
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates['name'] = input.name;
    if (input.icao !== undefined) updates['icao'] = input.icao ?? null;
    if (input.latitude !== undefined && input.longitude !== undefined) {
      updates['latitude']  = input.latitude  != null ? String(input.latitude)  : null;
      updates['longitude'] = input.longitude != null ? String(input.longitude) : null;
    }

    await tx.update(location).set(updates).where(eq(location.id, input.locationId));

    // 5. ONE audit row (before/after of the writable fields).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'location.updated',
      entityType:  'location',
      entityId:    input.locationId,
      metadata: {
        before: {
          name:      current.name,
          icao:      current.icao,
          latitude:  current.latitude  != null ? Number(current.latitude)  : null,
          longitude: current.longitude != null ? Number(current.longitude) : null,
        },
        after: {
          name: input.name ?? current.name,
          icao: input.icao !== undefined ? (input.icao ?? null) : current.icao,
          latitude:
            input.latitude !== undefined && input.longitude !== undefined
              ? (input.latitude ?? null)
              : (current.latitude != null ? Number(current.latitude) : null),
          longitude:
            input.latitude !== undefined && input.longitude !== undefined
              ? (input.longitude ?? null)
              : (current.longitude != null ? Number(current.longitude) : null),
        },
      },
    });

    // 6. Re-read the fresh row inside the same org context.
    const fresh = await tx
      .select({
        id:        location.id,
        name:      location.name,
        icao:      location.icao,
        latitude:  location.latitude,
        longitude: location.longitude,
      })
      .from(location)
      .where(eq(location.id, input.locationId))
      .limit(1);

    const row = fresh[0];
    if (!row) throw new Error('[fleet] updateLocation: re-read returned no row');

    return { ok: true, location: toLocationOption(row) };
  });
}

export async function updateLocation(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateLocationResult> {
  const db = await getDb();
  return _updateLocationImpl(db, session, input);
}

export async function updateLocationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateLocationResult> {
  return _updateLocationImpl(db, session, input);
}

// ─── Row → view ───────────────────────────────────────────────────────────────

function toLocationOption(row: {
  id: string;
  name: string;
  icao: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
}): LocationOption {
  return {
    id:        row.id,
    name:      row.name,
    icao:      row.icao ?? null,
    latitude:  row.latitude  != null ? Number(row.latitude)  : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
  };
}
