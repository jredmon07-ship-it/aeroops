/**
 * booking-triage.test.ts — Slice PB1.2 staff triage API integration tests.
 * pglite + *WithDb forms; migrations 0000–0015; two seeded orgs.
 *
 * COVERAGE:
 *
 * CAP — Capability enforcement:
 *   CAP-1  owner/manager/dispatcher → listBookingRequests passes.
 *   CAP-2  cfi/accountant/mechanic/renter/student → ForbiddenError (list).
 *   CAP-3  null session → UnauthenticatedError (list).
 *   CAP-4  owner/manager/dispatcher → updateBookingRequestStatus passes.
 *   CAP-5  cfi/accountant/mechanic/renter/student → ForbiddenError (update).
 *   CAP-6  null session → UnauthenticatedError (update).
 *   CAP-7  booking:triage granted to exactly owner/manager/dispatcher in matrix.
 *
 * T-ISO — Tenant isolation (RLS):
 *   T-ISO-1  org-A staff lists only org-A rows (not org-B rows).
 *   T-ISO-2  org-A staff cannot update org-B's request (not_found).
 *
 * LIST — listBookingRequests:
 *   LIST-1  default status='new' only returns new rows.
 *   LIST-2  status filter returns only matching rows.
 *   LIST-3  newest-first ordering (created_at DESC).
 *   LIST-4  counts reflect all statuses regardless of status filter.
 *   LIST-5  limit option caps results at the specified value (max 100).
 *
 * TRANS — Status transitions:
 *   TRANS-1  new → contacted: success, sets handled_by/handled_at.
 *   TRANS-2  new → declined: success, sets handled_by/handled_at.
 *   TRANS-3  contacted → converted: success (flag only — no reservation row).
 *   TRANS-4  contacted → declined: success.
 *   TRANS-5  contacted → contacted: success (re-note is valid).
 *   TRANS-6  new → converted: invalid_transition.
 *   TRANS-7  converted → anything: invalid_transition (terminal).
 *   TRANS-8  declined → anything: invalid_transition (terminal).
 *   TRANS-9  unknown id → not_found.
 *
 * AUDIT — Exactly one audit_log row per successful mutation:
 *   AUDIT-1  one audit row per status change.
 *   AUDIT-2  no audit row on invalid_transition.
 *   AUDIT-3  no audit row on not_found.
 *
 * SHAPE — DB shape checks:
 *   SHAPE-1  handled_shape_check: status='new' → handled_by/at NULL.
 *   SHAPE-2  handled_shape_check: status='contacted' → handled_at NOT NULL.
 *   SHAPE-3  triageNotes stored on update.
 *   SHAPE-4  requester fields unchanged after status mutation.
 *
 * NO-RSV — converted creates NO reservation row:
 *   NO-RSV-1  reservation count unchanged after converting a request.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  withPlatformAdminContext,
  seedTwoOrgs,
  loadMigrationSql,
} from '@aeroops/db';
import { bookingRequest, auditLog } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { CAPABILITIES, ROLE_CAPABILITIES, can } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';

import {
  listBookingRequestsWithDb,
  updateBookingRequestStatusWithDb,
} from '../index.js';
import {
  UnauthenticatedError,
  ForbiddenError,
} from '../auth/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// All up migrations through 0022 (shared loader — replaces the old hand list).
const MIGRATION_SQL = loadMigrationSql('0022');

// ── Shared test environment ───────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

let env: TestEnv;

// ── Session factory ───────────────────────────────────────────────────────────

function makeSession(
  role: MembershipRole,
  orgId: string,
  userId: string,
) {
  return {
    userId,
    orgId,
    slug: 'test-org',
    role,
    user: { email: 'staff@test.example' },
  };
}

// ── Booking request insert helper ─────────────────────────────────────────────

/**
 * Insert a booking_request row directly (bypassing the public submit path).
 * Must be called before setTestAppRole() (superuser context) or inside
 * withOrgContext (which satisfies the RLS INSERT policy).
 * Returns the inserted row id.
 */
async function insertBookingRequest(
  db: PgliteTestClient,
  orgId: string,
  overrides: Partial<{
    status: string;
    requesterName: string;
    requesterEmail: string;
    requestedStart: string;
    requestedEnd: string | null;
    message: string | null;
  }> = {},
): Promise<string> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      INSERT INTO booking_request (
        org_id, status, requester_name, requester_email,
        requested_start, message
      ) VALUES (
        ${orgId}::uuid,
        ${overrides.status ?? 'new'},
        ${overrides.requesterName ?? 'Test Requester'},
        ${overrides.requesterEmail ?? 'requester@test.example'},
        ${overrides.requestedStart ?? '2027-06-01T10:00:00Z'}::timestamptz,
        ${overrides.message ?? null}
      )
      RETURNING id
    `);
    const rows = result.rows as Array<{ id: string }>;
    return rows[0]!.id;
  });
}

/**
 * Count audit_log rows for a booking_request entity.
 */
async function countAuditRows(
  db: PgliteTestClient,
  orgId: string,
  entityId: string,
): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM audit_log
      WHERE org_id = ${orgId}::uuid
        AND entity_type = 'booking_request'
        AND entity_id   = ${entityId}::uuid
    `);
    const rows = result.rows as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  });
}

/**
 * Count reservation rows for an org (to verify no reservation was created).
 */
async function countReservations(
  db: PgliteTestClient,
  orgId: string,
): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      SELECT COUNT(*)::int AS cnt FROM reservation WHERE org_id = ${orgId}::uuid
    `);
    const rows = result.rows as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  });
}

/**
 * Fetch a single booking_request row by id (within org context).
 */
async function fetchBookingRequest(
  db: PgliteTestClient,
  orgId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(sql`
      SELECT * FROM booking_request WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
    `);
    const rows = result.rows as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);

  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };

  // Switch to restricted aeroops_app role so FORCE RLS is active.
  await setTestAppRole({ pglite });
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// CAP — Capability enforcement
// ═════════════════════════════════════════════════════════════════════════════

describe('CAP — Capability enforcement', () => {
  const ALLOWED: MembershipRole[] = ['owner', 'manager', 'dispatcher'];
  const DENIED:  MembershipRole[] = ['cfi', 'accountant', 'mechanic', 'renter', 'student'];

  for (const role of ALLOWED) {
    it(`CAP-1: ${role} can listBookingRequests (no throw)`, async () => {
      const { db, orgAId, userAId } = env;
      const session = makeSession(role, orgAId, userAId);
      // Just must not throw ForbiddenError/UnauthenticatedError.
      await expect(
        listBookingRequestsWithDb(db, session),
      ).resolves.toHaveProperty('rows');
    });
  }

  for (const role of DENIED) {
    it(`CAP-2: ${role} → ForbiddenError on listBookingRequests`, async () => {
      const { db, orgAId, userAId } = env;
      const session = makeSession(role, orgAId, userAId);
      await expect(
        listBookingRequestsWithDb(db, session),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  }

  it('CAP-3: null session → UnauthenticatedError on listBookingRequests', async () => {
    const { db } = env;
    await expect(
      listBookingRequestsWithDb(db, null),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  for (const role of ALLOWED) {
    it(`CAP-4: ${role} can updateBookingRequestStatus (no throw on not_found)`, async () => {
      const { db, orgAId, userAId } = env;
      const session = makeSession(role, orgAId, userAId);
      // A non-existent id should return not_found, not ForbiddenError.
      const result = await updateBookingRequestStatusWithDb(db, session, {
        id: '00000000-0000-0000-0000-000000000001',
        status: 'contacted',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });
  }

  for (const role of DENIED) {
    it(`CAP-5: ${role} → ForbiddenError on updateBookingRequestStatus`, async () => {
      const { db, orgAId, userAId } = env;
      const session = makeSession(role, orgAId, userAId);
      await expect(
        updateBookingRequestStatusWithDb(db, session, {
          id: '00000000-0000-0000-0000-000000000001',
          status: 'contacted',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  }

  it('CAP-6: null session → UnauthenticatedError on updateBookingRequestStatus', async () => {
    const { db } = env;
    await expect(
      updateBookingRequestStatusWithDb(db, null, {
        id: '00000000-0000-0000-0000-000000000001',
        status: 'contacted',
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('CAP-7: booking:triage granted to exactly owner/manager/dispatcher', () => {
    expect(CAPABILITIES).toContain('booking:triage');
    expect(can('owner',      'booking:triage')).toBe(true);
    expect(can('manager',    'booking:triage')).toBe(true);
    expect(can('dispatcher', 'booking:triage')).toBe(true);
    // Not granted to any other role.
    const notGranted: MembershipRole[] = ['cfi', 'mechanic', 'renter', 'student', 'accountant'];
    for (const role of notGranted) {
      expect(can(role, 'booking:triage')).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T-ISO — Tenant isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('T-ISO — Tenant isolation', () => {
  it('T-ISO-1: org-A staff lists only org-A rows (not org-B rows)', async () => {
    const { db, orgAId, orgBId, userAId, userBId } = env;

    // Insert a row in each org.
    await insertBookingRequest(db, orgAId, { requesterEmail: 'a-iso@test.example' });
    await insertBookingRequest(db, orgBId, { requesterEmail: 'b-iso@test.example' });

    const sessionA = makeSession('owner', orgAId, userAId);
    const sessionB = makeSession('owner', orgBId, userBId);

    const resultA = await listBookingRequestsWithDb(db, sessionA);
    const resultB = await listBookingRequestsWithDb(db, sessionB);

    // org-A sees only org-A rows.
    for (const row of resultA.rows) {
      expect(row.requesterEmail).not.toBe('b-iso@test.example');
    }
    // org-B sees only org-B rows.
    for (const row of resultB.rows) {
      expect(row.requesterEmail).not.toBe('a-iso@test.example');
    }
  });

  it('T-ISO-2: org-A staff cannot update org-B request (not_found via RLS)', async () => {
    const { db, orgAId, orgBId, userAId } = env;

    // Insert a row in org-B.
    const idB = await insertBookingRequest(db, orgBId, { requesterEmail: 'b-cross@test.example' });

    // Try to update it as org-A staff.
    const sessionA = makeSession('owner', orgAId, userAId);
    const result = await updateBookingRequestStatusWithDb(db, sessionA, {
      id: idB,
      status: 'contacted',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LIST — listBookingRequests
// ═════════════════════════════════════════════════════════════════════════════

describe('LIST — listBookingRequests', () => {
  it('LIST-1: default status=new only returns new rows', async () => {
    const { db, orgAId, userAId } = env;

    // Insert a 'new' and a 'contacted' (via direct update after insert).
    await insertBookingRequest(db, orgAId, { requesterEmail: 'list1-new@test.example', status: 'new' });

    const session = makeSession('owner', orgAId, userAId);
    const result = await listBookingRequestsWithDb(db, session);

    for (const row of result.rows) {
      expect(row.status).toBe('new');
    }
  });

  it('LIST-2: status filter returns only matching rows', async () => {
    const { db, orgAId, orgBId, userAId } = env;

    // Insert a new row, then update it to 'declined' via the API.
    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'list2@test.example' });
    const session = makeSession('owner', orgAId, userAId);
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'declined' });

    const result = await listBookingRequestsWithDb(db, session, { status: 'declined' });
    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain(id);
    for (const row of result.rows) {
      expect(row.status).toBe('declined');
    }
  });

  it('LIST-3: newest-first ordering (created_at DESC)', async () => {
    const { db, orgAId, userAId } = env;

    // Insert two rows with different timestamps (sequentially — pglite serial).
    await insertBookingRequest(db, orgAId, { requesterEmail: 'list3-first@test.example' });
    await insertBookingRequest(db, orgAId, { requesterEmail: 'list3-second@test.example' });

    const session = makeSession('owner', orgAId, userAId);
    const result = await listBookingRequestsWithDb(db, session);

    // Verify descending order by createdAt.
    for (let i = 1; i < result.rows.length; i++) {
      const prev = result.rows[i - 1]!.createdAt.getTime();
      const curr = result.rows[i]!.createdAt.getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('LIST-4: counts reflect all four statuses regardless of status filter', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    // Insert a row and transition it to 'contacted' to ensure counts cover multiple statuses.
    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'list4@test.example' });
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });

    // Filter for 'new', but counts should reflect all.
    const result = await listBookingRequestsWithDb(db, session, { status: 'new' });

    expect(result.counts).toHaveProperty('new');
    expect(result.counts).toHaveProperty('contacted');
    expect(result.counts).toHaveProperty('converted');
    expect(result.counts).toHaveProperty('declined');

    // contacted count must be >= 1 (we just set one).
    expect(result.counts.contacted).toBeGreaterThanOrEqual(1);
  });

  it('LIST-5: limit option caps results', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const result = await listBookingRequestsWithDb(db, session, { limit: 2 });
    expect(result.rows.length).toBeLessThanOrEqual(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TRANS — Status transitions
// ═════════════════════════════════════════════════════════════════════════════

describe('TRANS — Status transitions', () => {
  it('TRANS-1: new → contacted: success, sets handled_by/handled_at', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans1@test.example' });
    const result = await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('contacted');
    }

    // Verify handled_by and handled_at are set in the DB.
    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row).not.toBeNull();
    expect(row!['status']).toBe('contacted');
    expect(row!['handled_by']).toBe(userAId);
    expect(row!['handled_at']).not.toBeNull();
  });

  it('TRANS-2: new → declined: success, sets handled_by/handled_at', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans2@test.example' });
    const result = await updateBookingRequestStatusWithDb(db, session, { id, status: 'declined' });

    expect(result.ok).toBe(true);
    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['status']).toBe('declined');
    expect(row!['handled_at']).not.toBeNull();
  });

  it('TRANS-3 (PB2.1b regression): contacted → converted via updateBookingRequestStatus is now invalid_transition', async () => {
    // PB2.1b removed 'converted' as a reachable target from this command — the
    // ONLY path to converted is convertBookingRequest (atomic create-reservation
    // + flip). updateBookingRequestStatus contacted→converted now refuses.
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const reservationsBefore = await countReservations(db, orgAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans3@test.example' });
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });
    const result = await updateBookingRequestStatusWithDb(db, session, { id, status: 'converted' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_transition');
    }
    // Row remains 'contacted' (the refused convert did not mutate it).
    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['status']).toBe('contacted');

    // NO-RSV: reservation table must be unchanged.
    const reservationsAfter = await countReservations(db, orgAId);
    expect(reservationsAfter).toBe(reservationsBefore);
  });

  it('TRANS-4: contacted → declined: success', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans4@test.example' });
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });
    const result = await updateBookingRequestStatusWithDb(db, session, { id, status: 'declined' });

    expect(result.ok).toBe(true);
    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['status']).toBe('declined');
  });

  it('TRANS-5: contacted → contacted: success (re-note is valid)', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans5@test.example' });
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });
    const result = await updateBookingRequestStatusWithDb(db, session, {
      id,
      status: 'contacted',
      triageNotes: 'Called again, left voicemail.',
    });

    expect(result.ok).toBe(true);
    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['status']).toBe('contacted');
    expect(row!['triage_notes']).toBe('Called again, left voicemail.');
  });

  it('TRANS-6: new → converted: invalid_transition', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans6@test.example' });
    const result = await updateBookingRequestStatusWithDb(db, session, { id, status: 'converted' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_transition');
    }

    // Row must remain 'new'.
    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['status']).toBe('new');
  });

  it('TRANS-7: converted → any: invalid_transition (terminal)', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    // PB2.1b: updateBookingRequestStatus can no longer reach 'converted'. Force
    // the terminal status directly (converted is normally produced ONLY by
    // convertBookingRequest), then assert no outgoing transition is allowed.
    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans7@test.example' });
    await withOrgContext(db, orgAId, async (tx) => {
      await (tx as typeof db).execute(sql`
        UPDATE booking_request
        SET status = 'converted', handled_by = ${userAId}::uuid, handled_at = now()
        WHERE id = ${id}::uuid
      `);
    });

    for (const targetStatus of ['new', 'contacted', 'declined', 'converted'] as const) {
      const result = await updateBookingRequestStatusWithDb(db, session, { id, status: targetStatus });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_transition');
      }
    }
  });

  it('TRANS-8: declined → any: invalid_transition (terminal)', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'trans8@test.example' });
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'declined' });

    for (const targetStatus of ['new', 'contacted', 'converted', 'declined'] as const) {
      const result = await updateBookingRequestStatusWithDb(db, session, { id, status: targetStatus });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_transition');
      }
    }
  });

  it('TRANS-9: unknown id → not_found', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const result = await updateBookingRequestStatusWithDb(db, session, {
      id: '00000000-0000-0000-0000-000000000099',
      status: 'contacted',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUDIT — Exactly one audit_log row per successful mutation
// ═════════════════════════════════════════════════════════════════════════════

describe('AUDIT — Audit log integrity', () => {
  it('AUDIT-1: exactly one audit row per successful status change', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'audit1@test.example' });

    // Zero before.
    expect(await countAuditRows(db, orgAId, id)).toBe(0);

    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });
    expect(await countAuditRows(db, orgAId, id)).toBe(1);

    await updateBookingRequestStatusWithDb(db, session, { id, status: 'declined' });
    expect(await countAuditRows(db, orgAId, id)).toBe(2);
  });

  it('AUDIT-2: no audit row on invalid_transition', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'audit2@test.example' });

    // new → converted is invalid.
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'converted' });
    expect(await countAuditRows(db, orgAId, id)).toBe(0);
  });

  it('AUDIT-3: no audit row on not_found', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    // Non-existent id.
    await updateBookingRequestStatusWithDb(db, session, {
      id: '00000000-0000-0000-0000-000000000088',
      status: 'contacted',
    });

    // Can't count audit for this id (not visible to org-A anyway), but we
    // assert zero specifically for org A's audit_log over that phantom id.
    const count = await countAuditRows(db, orgAId, '00000000-0000-0000-0000-000000000088');
    expect(count).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SHAPE — DB shape checks
// ═════════════════════════════════════════════════════════════════════════════

describe('SHAPE — DB shape checks', () => {
  it('SHAPE-1: status=new → handled_by and handled_at are NULL', async () => {
    const { db, orgAId } = env;

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'shape1@test.example' });
    const row = await fetchBookingRequest(db, orgAId, id);

    expect(row!['status']).toBe('new');
    expect(row!['handled_by']).toBeNull();
    expect(row!['handled_at']).toBeNull();
  });

  it('SHAPE-2: after transition → handled_at IS NOT NULL (shape check satisfied)', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'shape2@test.example' });
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });

    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['handled_at']).not.toBeNull();
  });

  it('SHAPE-3: triageNotes stored on update', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'shape3@test.example' });
    await updateBookingRequestStatusWithDb(db, session, {
      id,
      status: 'contacted',
      triageNotes: 'Left a voicemail on 2026-06-20.',
    });

    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['triage_notes']).toBe('Left a voicemail on 2026-06-20.');
  });

  it('SHAPE-4: requester fields unchanged after status mutation', async () => {
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const id = await insertBookingRequest(db, orgAId, {
      requesterEmail: 'shape4@test.example',
      requesterName: 'Original Name',
      message: 'Original message',
    });

    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });

    const row = await fetchBookingRequest(db, orgAId, id);
    expect(row!['requester_name']).toBe('Original Name');
    expect(row!['requester_email']).toBe('shape4@test.example');
    expect(row!['message']).toBe('Original message');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NO-RSV — converted creates NO reservation row
// ═════════════════════════════════════════════════════════════════════════════

describe('NO-RSV — updateBookingRequestStatus never reaches converted (PB2.1b)', () => {
  it('NO-RSV-1: updateBookingRequestStatus can no longer convert; reservation count unchanged', async () => {
    // PB2.1b: the flag-only convert path was removed from this command. Attempting
    // contacted → converted here is an invalid_transition and writes no reservation.
    const { db, orgAId, userAId } = env;
    const session = makeSession('owner', orgAId, userAId);

    const reservationsBefore = await countReservations(db, orgAId);

    const id = await insertBookingRequest(db, orgAId, { requesterEmail: 'norsv1@test.example' });
    await updateBookingRequestStatusWithDb(db, session, { id, status: 'contacted' });
    const result = await updateBookingRequestStatusWithDb(db, session, { id, status: 'converted' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_transition');
    }

    const reservationsAfter = await countReservations(db, orgAId);
    expect(reservationsAfter).toBe(reservationsBefore);
  });
});
