/**
 * types.ts — Auth session type definitions for AeroOps.
 *
 * Exports the framework-agnostic AppSession shape used by withSessionOrgContext
 * and all server-side code that needs the authenticated user context.
 *
 * NEXT-AUTH MODULE AUGMENTATION NOTE:
 *   The `declare module 'next-auth'` augmentations for Session, User, and JWT
 *   must live in apps/web (where `next` is installed and next-auth's types can
 *   be fully resolved). Placing them in packages/api would require `next` as a
 *   dependency here, which violates the boundary that @aeroops/api is
 *   framework-agnostic.
 *
 *   The frontend-engineer should create apps/web/src/types/next-auth.d.ts with:
 *
 *   ```ts
 *   import type { MembershipRole } from '@aeroops/core';
 *
 *   declare module 'next-auth' {
 *     interface Session {
 *       userId: string;
 *       orgId: string;
 *       role: MembershipRole;
 *       user: { email: string };
 *     }
 *     interface User {
 *       id: string;
 *       orgId: string;
 *       role: MembershipRole;
 *       email: string;
 *       cfp: string;   // session credential fingerprint — never on Session
 *     }
 *   }
 *
 *   declare module 'next-auth/jwt' {
 *     interface JWT {
 *       userId: string;
 *       orgId: string;
 *       role: MembershipRole;
 *       email: string;
 *       cfp?: string;  // see session-revalidation.ts
 *     }
 *   }
 *   ```
 *
 *   This file (apps/web/src/types/next-auth.d.ts) is included automatically by
 *   TypeScript if it is under the `include` path in apps/web's tsconfig.json.
 */
import type { MembershipRole } from '@aeroops/core';

// ─── Framework-agnostic session shape ────────────────────────────────────────

/**
 * AppSession — the canonical session shape used by all server-side code
 * that needs the authenticated user context.
 *
 * apps/web obtains a NextAuth Session via its `auth()` helper, then passes
 * it (or a compatible object) to withSessionOrgContext. The field names must
 * match what buildAuthConfig's callbacks.session puts onto the session object.
 *
 * user.email mirrors the standard Auth.js session.user.email field.
 * userId, orgId, role are AeroOps extensions set by the jwt + session callbacks.
 */
export interface AppSession {
  user: {
    email: string;
  };
  userId: string;
  orgId: string;
  slug: string;
  role: MembershipRole;
}
