/**
 * auth/index.ts — barrel for the auth module.
 *
 * Re-exports the public surface of the auth package.
 * The top-level packages/api/src/index.ts re-exports from here.
 */
export { buildAuthConfig, buildEdgeAuthConfig, jwtCallback, sessionCallback } from './auth-config.js';
export { resolveOrgBySlug } from './resolve-org.js';
export type { ResolvedOrg } from './resolve-org.js';
export { verifyCredential } from './verify-credential.js';
export type { VerifiedCredential } from './verify-credential.js';
export { hashPassword } from './hash.js';
export { withSessionOrgContext, withSessionOrgContextWithDb, UnauthenticatedError } from './session.js';
export type { AppSession } from './session.js';
export { getSessionOrg } from './get-session-org.js';
export type { SessionOrgData } from './get-session-org.js';
export { ForbiddenError, requireCapability, hasCapability } from './require-capability.js';
