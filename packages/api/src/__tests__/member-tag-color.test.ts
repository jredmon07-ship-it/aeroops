/**
 * member-tag-color.test.ts — colored member tags (migration 0041).
 *
 * Applies migrations 0000–0041 (0041 adds member_tag.color + the palette CHECK).
 *
 * COVERAGE:
 *   CAPS: addMemberTag needs people:manage (owner/manager); a people:access-only
 *     role (dispatcher) ⇒ Forbidden; a non-people role (renter) ⇒ Forbidden;
 *     null session ⇒ Unauthenticated (all BEFORE any DB access).
 *   HAPPY: a colored tag round-trips — getMemberDetail exposes tag.color and
 *     listMembers exposes the matching tagChips entry.
 *   DEFAULT: a tag added WITHOUT a color persists color=null (renders slate);
 *     absent-color behavior is byte-identical to the pre-0041 shape.
 *   VALIDATION: an off-palette color is rejected by the zod enum (ValidationError).
 *   PALETTE CHECK: a raw INSERT of an off-palette color is rejected by the DB
 *     CHECK constraint member_tag_color_check.
 *   T-ISO: org B cannot color-tag an org A member (cross-org userId ⇒ not_found),
 *     and org A's colored tags never leak into org B's listMembers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  seedTwoOrgs,
  loadMigrationSql,
  memberTag,
} from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { addMemberTagWithDb } from '../people/add-member-tag.js';
import { getMemberDetailWithDb } from '../people/get-member-detail.js';
import { listMembersWithDb } from '../people/list-members.js';

import { ValidationError } from '../scheduling/internal.js';
import { UnauthenticatedError } from '../auth/session.js';
import { ForbiddenError } from '../auth/require-capability.js';
import type { AppSession } from '../auth/types.js';

// All up migrations through 0041 (adds member_tag.color).
const MIGRATION_SQL = loadMigrationSql('0041');

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
}

function makeSession(
  orgId: string,
  userId: string,
  role: AppSession['role'] = 'owner',
): AppSession {
  return { userId, orgId, slug: 'test', role, user: { email: 'test@example.com' } };
}

let env: TestEnv;

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);
  const seed = await seedTwoOrgs(db);
  await setTestAppRole({ pglite });
  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    orgBId: seed.orgBId,
    userAId: seed.userAId,
    userBId: seed.userBId,
  };
}, 60_000);

describe('capabilities', () => {
  it('addMemberTag requires people:manage', async () => {
    const { db, orgAId, userAId } = env;

    // people:access-only role (dispatcher) is refused.
    await expect(
      addMemberTagWithDb(db, makeSession(orgAId, userAId, 'dispatcher'), {
        userId: userAId,
        tag: 'X',
        color: 'sky',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // non-people role (renter) is refused.
    await expect(
      addMemberTagWithDb(db, makeSession(orgAId, userAId, 'renter'), {
        userId: userAId,
        tag: 'X',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // null session ⇒ Unauthenticated.
    await expect(
      addMemberTagWithDb(db, null, { userId: userAId, tag: 'X' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('happy path — a colored tag round-trips', () => {
  it('persists color and surfaces it in getMemberDetail + listMembers', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');

    const added = await addMemberTagWithDb(db, sess, {
      userId: userAId,
      tag: 'Complex endorsement',
      color: 'violet',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const tag = added.member.tags.find((t) => t.tag === 'Complex endorsement');
    expect(tag?.color).toBe('violet');

    // getMemberDetail exposes the color.
    const detail = await getMemberDetailWithDb(db, sess, { userId: userAId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.member.tags.find((t) => t.tag === 'Complex endorsement')?.color).toBe('violet');

    // listMembers exposes a matching tagChips entry (tags array unchanged).
    const members = await listMembersWithDb(db, sess);
    const me = members.find((m) => m.userId === userAId);
    expect(me?.tags).toContain('Complex endorsement');
    expect(me?.tagChips).toEqual(
      expect.arrayContaining([{ tag: 'Complex endorsement', color: 'violet' }]),
    );
  });
});

describe('default — a tag with no color persists null', () => {
  it('color is null (renders slate) and byte-identical to the pre-0041 shape', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');

    const added = await addMemberTagWithDb(db, sess, { userId: userAId, tag: 'No color tag' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    expect(added.member.tags.find((t) => t.tag === 'No color tag')?.color).toBeNull();

    const members = await listMembersWithDb(db, sess);
    const me = members.find((m) => m.userId === userAId);
    expect(me?.tagChips).toEqual(
      expect.arrayContaining([{ tag: 'No color tag', color: null }]),
    );
  });
});

describe('validation + palette CHECK', () => {
  it('an off-palette color is rejected by the zod enum (ValidationError)', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    await expect(
      addMemberTagWithDb(db, sess, {
        userId: userAId,
        tag: 'Bad color',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        color: 'fuchsia' as any,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a raw INSERT of an off-palette color is rejected by member_tag_color_check', async () => {
    const { db, orgAId, userAId } = env;
    await expect(
      withOrgContext(db, orgAId, (tx) =>
        tx.insert(memberTag).values({
          orgId: orgAId,
          userId: userAId,
          tag: 'Raw bad color',
          // TS types color as `text`, so this only fails at the DB CHECK.
          color: 'chartreuse',
          createdBy: userAId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('every palette key is accepted', async () => {
    const { db, orgAId, userAId } = env;
    const sess = makeSession(orgAId, userAId, 'owner');
    const palette = ['slate', 'red', 'amber', 'green', 'sky', 'violet', 'rose', 'teal'] as const;
    for (const color of palette) {
      const r = await addMemberTagWithDb(db, sess, {
        userId: userAId,
        tag: `palette-${color}`,
        color,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.member.tags.find((t) => t.tag === `palette-${color}`)?.color).toBe(color);
      }
    }
  });
});

describe('tenant isolation', () => {
  it('org B cannot color-tag an org A member (cross-org userId ⇒ not_found)', async () => {
    const { db, orgBId, userBId, userAId } = env;
    const sessB = makeSession(orgBId, userBId, 'owner');
    const r = await addMemberTagWithDb(db, sessB, {
      userId: userAId, // org A member — invisible to org B
      tag: 'Injected',
      color: 'red',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it("org A's colored tags never appear in org B's listMembers", async () => {
    const { db, orgBId, userBId } = env;
    const sessB = makeSession(orgBId, userBId, 'owner');
    const members = await listMembersWithDb(db, sessB);
    const allChips = members.flatMap((m) => m.tagChips.map((c) => c.tag));
    expect(allChips).not.toContain('Complex endorsement');
    expect(allChips).not.toContain('Injected');
  });
});
