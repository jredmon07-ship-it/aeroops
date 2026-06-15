/**
 * Schema barrel — re-exports all tables, the membership_role enum,
 * and inferred model types.
 *
 * Tenant-scoped tables (RLS ENABLE + FORCE in migration):
 *   org, location, appUser (table: app_user), membership, auditLog (table: audit_log),
 *   authCredential (table: auth_credential)
 *
 * Platform/control-plane tables (NO RLS):
 *   plan, subscription
 */

// Enum (derived from @aeroops/core MEMBERSHIP_ROLES)
export { membershipRole } from './enums.js';

// Tenant-scoped tables
export { org } from './org.js';
export type { OrgSelect, OrgInsert } from './org.js';

export { location } from './location.js';
export type { LocationSelect, LocationInsert } from './location.js';

export { appUser, users } from './user.js';
export type { AppUserSelect, AppUserInsert } from './user.js';

export { membership } from './membership.js';
export type { MembershipSelect, MembershipInsert } from './membership.js';

export { auditLog } from './audit-log.js';
export type { AuditLogSelect, AuditLogInsert } from './audit-log.js';

export { authCredential } from './auth-credential.js';
export type { AuthCredentialSelect, AuthCredentialInsert } from './auth-credential.js';

// Platform / control-plane tables (NOT org-scoped)
export { plan } from './plan.js';
export type { PlanSelect, PlanInsert } from './plan.js';

export { subscription } from './subscription.js';
export type { SubscriptionSelect, SubscriptionInsert } from './subscription.js';
