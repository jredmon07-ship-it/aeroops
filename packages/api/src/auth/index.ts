/**
 * auth/index.ts — barrel for the auth module.
 *
 * Re-exports the public surface of the auth package.
 * The top-level packages/api/src/index.ts re-exports from here.
 */
export { buildAuthConfig, buildEdgeAuthConfig, jwtCallback, sessionCallback, loginSchema } from './auth-config.js';
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

// ─── Slice 4M.1 — Mobile auth pipeline ───────────────────────────────────────
export { verifyLoginAndIssueClaims, verifyLoginAndIssueClaimsWithDb } from './verify-login.js';
export type { MobileClaims } from './verify-login.js';
export {
  signMobileToken,
  verifyMobileToken,
  sessionFromMobileClaims,
  MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS,
} from './mobile-token.js';

// ─── Slice 4M-REVOKE — Mobile refresh-token sessions ([VERIFY-4M-SEC-1]) ──────
export { resolveMobileSessionByHash } from './resolve-mobile-session.js';
export type { ResolvedMobileSession } from './resolve-mobile-session.js';
export {
  issueMobileSession,
  issueMobileSessionWithDb,
  refreshMobileSession,
  refreshMobileSessionWithDb,
  revokeMobileSession,
  revokeMobileSessionWithDb,
  revokeAllMobileSessionsForUser,
  revokeAllMobileSessionsForUserWithDb,
  generateRefreshToken,
  hashRefreshToken,
} from './mobile-session.js';
export type { IssuedMobileSession, IssueMobileSessionOpts } from './mobile-session.js';
