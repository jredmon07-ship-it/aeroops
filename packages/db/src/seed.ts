/**
 * seed.ts — deterministic test seed.
 *
 * seedTwoOrgs(db): creates two isolated orgs (A and B) under
 * platform-admin context, then within each org's context creates:
 *   - one location
 *   - one app_user
 *   - one membership (role: owner)
 * And at platform level:
 *   - one plan (shared)
 *   - one subscription per org
 *
 * Returns all created IDs for use in assertions.
 *
 * NOTE: seed uses withPlatformAdminContext for org creation and
 * withOrgContext for tenant-scoped inserts, mirroring the production
 * code path and exercising the RLS policies.
 *
 * seedAuthCredential(db, orgId, userId, passwordHash):
 *   Creates an auth_credential row for a seeded user.
 *   Pass a real argon2id encoded string from the backend; for smoke tests
 *   use any non-empty placeholder (e.g. '$argon2id$dummy').
 *
 * seedUserWithoutMembership(db, orgId, email):
 *   Creates an app_user with NO membership row. Used to test the
 *   no-membership-bounce behaviour in the auth flow (Slice 0.3).
 */
import { org, location, appUser, membership, plan, subscription, authCredential } from './schema/index.js';
import { withOrgContext, withPlatformAdminContext } from './org-context.js';
import type { PgliteTestClient, ProdClient } from './client.js';

// FIX 3: createProdClient is now async; use ProdClient (the resolved type).
type AnyDb = ProdClient | PgliteTestClient;

export interface SeedResult {
  orgAId: string;
  orgBId: string;
  locationAId: string;
  locationBId: string;
  userAId: string;
  userBId: string;
  membershipAId: string;
  membershipBId: string;
  planId: string;
  subscriptionAId: string;
  subscriptionBId: string;
}

export async function seedTwoOrgs(db: AnyDb): Promise<SeedResult> {
  // ── 1. Create Org A and Org B under platform-admin context ──────────────
  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight School', slug: 'alpha' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Flying Club', slug: 'beta' })
      .returning();
    return [a[0]!, b[0]!];
  });

  // ── 2. Create tenant rows for Org A ─────────────────────────────────────
  const [locA, userA, memberA] = await withOrgContext(db, orgA.id, async (tx) => {
    const loc = await tx
      .insert(location)
      .values({ orgId: orgA.id, name: 'Alpha Main Base', icao: 'KABC' })
      .returning();

    const usr = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha.example', fullName: 'Alice Alpha' })
      .returning();

    const mem = await tx
      .insert(membership)
      .values({ orgId: orgA.id, userId: usr[0]!.id, role: 'owner' })
      .returning();

    return [loc[0]!, usr[0]!, mem[0]!];
  });

  // ── 3. Create tenant rows for Org B ─────────────────────────────────────
  const [locB, userB, memberB] = await withOrgContext(db, orgB.id, async (tx) => {
    const loc = await tx
      .insert(location)
      .values({ orgId: orgB.id, name: 'Beta Main Base', icao: 'KBCD' })
      .returning();

    const usr = await tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta.example', fullName: 'Bob Beta' })
      .returning();

    const mem = await tx
      .insert(membership)
      .values({ orgId: orgB.id, userId: usr[0]!.id, role: 'owner' })
      .returning();

    return [loc[0]!, usr[0]!, mem[0]!];
  });

  // ── 4. Create plan + subscriptions at platform level ────────────────────
  const [sharedPlan, subA, subB] = await withPlatformAdminContext(db, async (tx) => {
    const p = await tx
      .insert(plan)
      .values({ code: 'starter', name: 'Starter' })
      .returning();

    const sA = await tx
      .insert(subscription)
      .values({ orgId: orgA.id, planId: p[0]!.id, status: 'trialing' })
      .returning();

    const sB = await tx
      .insert(subscription)
      .values({ orgId: orgB.id, planId: p[0]!.id, status: 'trialing' })
      .returning();

    return [p[0]!, sA[0]!, sB[0]!];
  });

  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    locationAId: locA.id,
    locationBId: locB.id,
    userAId: userA.id,
    userBId: userB.id,
    membershipAId: memberA.id,
    membershipBId: memberB.id,
    planId: sharedPlan.id,
    subscriptionAId: subA.id,
    subscriptionBId: subB.id,
  };
}

/**
 * seedAuthCredential — inserts an auth_credential row for an existing user.
 *
 * Must be called:
 *   - AS SUPERUSER (before setTestAppRole) so that the INSERT is not blocked
 *     by RLS during test setup. In production the backend-engineer calls this
 *     via withOrgContext when creating the account.
 *   - AFTER the user has been created in app_user (composite FK enforces this).
 *
 * @param db        - The Drizzle client (test or prod).
 * @param orgId     - UUID of the org the user belongs to.
 * @param userId    - UUID of the app_user row.
 * @param passwordHash - argon2id encoded string produced by the backend.
 *                       For smoke tests use a clearly-dummy value such as
 *                       '$argon2id$dummy'. Never a raw password.
 * @returns The created auth_credential row.
 */
export async function seedAuthCredential(
  db: AnyDb,
  orgId: string,
  userId: string,
  passwordHash: string,
) {
  return withOrgContext(db, orgId, async (tx) => {
    const [row] = await tx
      .insert(authCredential)
      .values({ orgId, userId, passwordHash })
      .returning();
    return row!;
  });
}

/**
 * seedUserWithoutMembership — creates an app_user with NO membership row.
 *
 * Used to test the no-membership-bounce behavior in the auth flow (Slice 0.3):
 * a user exists in the org but has no role assignment, so the login should
 * bounce them rather than granting access.
 *
 * Must be called as SUPERUSER (before setTestAppRole).
 *
 * @param db    - The Drizzle client.
 * @param orgId - UUID of the org.
 * @param email - Email address for the user (must be unique within the org).
 * @param fullName - Optional display name.
 * @returns The created app_user row.
 */
export async function seedUserWithoutMembership(
  db: AnyDb,
  orgId: string,
  email: string,
  fullName?: string,
) {
  return withOrgContext(db, orgId, async (tx) => {
    const [user] = await tx
      .insert(appUser)
      .values({ orgId, email, fullName: fullName ?? null })
      .returning();
    return user!;
  });
}
