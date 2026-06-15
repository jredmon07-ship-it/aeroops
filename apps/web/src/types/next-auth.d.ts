/**
 * next-auth.d.ts — Module augmentation for Auth.js v5 session types.
 *
 * Extends the default Session, User, and JWT interfaces with AeroOps
 * custom fields (orgId, slug, role). These must live in apps/web (not
 * packages/api) because augmenting 'next-auth' requires 'next' to be
 * present in the same package.
 *
 * This file is automatically picked up by TypeScript when it is under
 * the `include` path in apps/web's tsconfig.json.
 *
 * See packages/api/src/auth/types.ts for the canonical AppSession shape
 * (framework-agnostic) and the inline augmentation template.
 */
import type { MembershipRole } from '@aeroops/core';

declare module 'next-auth' {
  interface Session {
    userId: string;
    orgId: string;
    slug: string;
    role: MembershipRole;
    user: {
      email: string;
    };
  }

  interface User {
    id: string;
    orgId: string;
    slug: string;
    role: MembershipRole;
    email: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId: string;
    orgId: string;
    slug: string;
    role: MembershipRole;
    email: string;
  }
}
