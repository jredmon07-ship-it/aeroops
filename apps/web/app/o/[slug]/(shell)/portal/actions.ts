/**
 * portal/actions.ts — Server actions for the student/renter self-service portal
 * (Slice P1.2).
 *
 * Pattern mirrors reporting-actions.ts and people/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Serialize Dates → ISO strings at the action boundary.
 *
 * THE LOAD-BEARING REQUIREMENT — SELF-SCOPING:
 *   getMyPortalSummary takes no userId parameter. The API enforces that the
 *   subject is session.userId from the verified JWT only. This file passes the
 *   session through unchanged — there is no client-controlled userId here.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + session.userId self-scoping enforced inside the API functions.
 *
 * [VERIFY-T1-B]: progressRatio is content-coverage, NOT a regulatory outcome.
 * [VERIFY-6-A]: tags are free-text only — no FAA/currency/medical meaning.
 * [MONEY BOUNDARY — P1]: the P1 summary above carries NO price/rate/balance.
 *
 * Slice P0-REV ADDITIVELY extends this file with self-pay actions
 * (getMyBillingAction / createMySetupIntentAction / saveMyPaymentMethodAction /
 * setMyAutopayAction / payMyInvoiceAction / getStripePublishableConfigAction)
 * — see that section below for its own self-scoping + PCI notes.
 */
'use server';

import { serializePilotLog, type SerializedPilotLog } from '@/lib/serialize-pilot-log';

import { auth } from '@/auth';
import {
  getMyPortalSummary,
  getMyBilling,
  createMySetupIntent,
  saveMyPaymentMethod,
  setMyAutopay,
  payMyInvoice,
  createCalendarFeed,
  listMyCalendarFeeds,
  revokeCalendarFeed,
  regenerateCalendarFeed,
  getMyDocuments,
  getMyDocumentDownloadUrl,
  getMyPilotLog,
  exportMyPilotLogCsv,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  MyPortalSummary,
  MyAccountView,
  MyReservationRow,
  MyEnrollmentRow,
  InvoiceView,
  SavedPaymentMethodView,
  AutopaySettingView,
  CalendarFeedView,
  DocumentView,
  PilotLog,
  PilotLogEntry,
} from '@aeroops/api';

// ─── Error shapes ─────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

// ─── Serialized types (Dates → ISO strings) ────────────────────────────────────

/** MyAccountView with Date objects replaced by ISO strings. */
export interface SerializedMyAccountView {
  userId: string;
  displayName: string;
  email: string;
  phone: string | null;
  role: string;
  joinedAt: string; // ISO string
  tags: Array<{ id: string; tag: string }>;
}

/** MyReservationRow with Date objects replaced by ISO strings. */
export interface SerializedMyReservationRow {
  id: string;
  startAt: string; // ISO string
  endAt: string;   // ISO string
  seriesId: string | null;
  resourceIds: string[];
  role: 'booker' | 'pilot' | 'booker_and_pilot';
}

/** MyEnrollmentRow with Date objects replaced by ISO strings. */
export interface SerializedMyEnrollmentRow {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  status: string;
  enrolledAt: string;       // ISO string
  statusChangedAt: string | null; // ISO string
  completedCount: number;
  totalLessons: number;
  progressRatio: {
    completed: number;
    total: number;
    ratio: number;
    percent: number;
  };
}

/** MyPortalSummary with all Dates serialized. */
export interface SerializedMyPortalSummary {
  account: SerializedMyAccountView;
  reservations: SerializedMyReservationRow[];
  training: SerializedMyEnrollmentRow[];
}

function serializeAccount(a: MyAccountView): SerializedMyAccountView {
  return {
    userId: a.userId,
    displayName: a.displayName,
    email: a.email,
    phone: a.phone,
    role: a.role,
    joinedAt: a.joinedAt instanceof Date ? a.joinedAt.toISOString() : String(a.joinedAt),
    tags: a.tags,
  };
}

function serializeReservation(r: MyReservationRow): SerializedMyReservationRow {
  return {
    id: r.id,
    startAt: r.startAt instanceof Date ? r.startAt.toISOString() : String(r.startAt),
    endAt: r.endAt instanceof Date ? r.endAt.toISOString() : String(r.endAt),
    seriesId: r.seriesId,
    resourceIds: r.resourceIds,
    role: r.role,
  };
}

function serializeEnrollment(e: MyEnrollmentRow): SerializedMyEnrollmentRow {
  return {
    enrollmentId: e.enrollmentId,
    courseId: e.courseId,
    courseTitle: e.courseTitle,
    status: e.status,
    enrolledAt: e.enrolledAt instanceof Date ? e.enrolledAt.toISOString() : String(e.enrolledAt),
    statusChangedAt:
      e.statusChangedAt instanceof Date
        ? e.statusChangedAt.toISOString()
        : e.statusChangedAt !== null
          ? String(e.statusChangedAt)
          : null,
    completedCount: e.completedCount,
    totalLessons: e.totalLessons,
    progressRatio: {
      completed: e.progressRatio.completed,
      total: e.progressRatio.total,
      ratio: e.progressRatio.ratio,
      percent: e.progressRatio.percent,
    },
  };
}

function serializeSummary(s: MyPortalSummary): SerializedMyPortalSummary {
  return {
    account: serializeAccount(s.account),
    reservations: s.reservations.map(serializeReservation),
    training: s.training.map(serializeEnrollment),
  };
}

// ─── getMyPortalSummaryAction ─────────────────────────────────────────────────

export type GetMyPortalSummaryActionResult =
  | { ok: true; summary: SerializedMyPortalSummary }
  | AuthErrorResult
  | ServerErrorResult;

/**
 * getMyPortalSummaryAction — server action for the portal page.
 *
 * requireCapability('portal:access') is enforced inside getMyPortalSummary().
 * The session is obtained from the signed JWT — the caller cannot supply a
 * userId, so self-scoping is guaranteed.
 */
export async function getMyPortalSummaryAction(): Promise<GetMyPortalSummaryActionResult> {
  const session = await auth();
  try {
    const summary = await getMyPortalSummary(session);
    return { ok: true, summary: serializeSummary(summary) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Slice P0-REV — Portal self-pay actions
//
// SELF-SCOPING (unchanged pattern): every function below takes NO
// row-identifying / userId input — the subject is ALWAYS session.userId from
// the verified JWT, enforced inside the @aeroops/api command (portal:access +
// self-scope). NEVER a card/bank value crosses this file — only Stripe's own
// ids (client_secret / setupIntentId / paymentMethodId) and Stripe-returned
// DISPLAY fields (type/last4/brand). The raw card/bank entry happens on a
// Stripe-hosted Element client-side, entirely outside this server (PCI SAQ-A).
// ════════════════════════════════════════════════════════════════════════════════

/** Serialized InvoiceView — mirrors billing/actions.ts's SerializedInvoiceRow shape. */
export interface SerializedMyInvoiceRow {
  id: string;
  status: string;
  subtotalCents: number;
  totalCents: number;
  issuedAt: string | null;
  createdAt: string;
}

function serializeMyInvoice(inv: InvoiceView): SerializedMyInvoiceRow {
  return {
    id: inv.id,
    status: inv.status,
    subtotalCents: inv.subtotalCents,
    totalCents: inv.totalCents,
    issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
    createdAt: inv.createdAt.toISOString(),
  };
}

export interface SerializedMyBilling {
  balanceCents: number;
  invoices: SerializedMyInvoiceRow[];
  paymentMethods: SavedPaymentMethodView[];
  autopay: AutopaySettingView;
}

export type GetMyBillingActionResult =
  | { ok: true; billing: SerializedMyBilling }
  | AuthErrorResult
  | ServerErrorResult;

/** getMyBillingAction — own balance + own invoices + own saved PMs + own autopay setting. */
export async function getMyBillingAction(): Promise<GetMyBillingActionResult> {
  const session = await auth();
  try {
    const billing = await getMyBilling(session);
    return {
      ok: true,
      billing: {
        balanceCents: billing.balanceCents,
        invoices: billing.invoices.map(serializeMyInvoice),
        paymentMethods: billing.paymentMethods,
        autopay: billing.autopay,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getStripePublishableConfigAction ─────────────────────────────────────────

export interface StripePublishableConfig {
  configured: boolean;
  publishableKey?: string;
}

/**
 * getStripePublishableConfigAction — the publishable key is PUBLIC (safe to
 * send to the browser by design — Stripe's own docs). The SECRET key never
 * leaves the server. `configured:false` when STRIPE_PUBLISHABLE_KEY is unset
 * — the client renders a clean "payments not enabled by your operator yet"
 * state in that case.
 */
export async function getStripePublishableConfigAction(): Promise<StripePublishableConfig> {
  const key = process.env['STRIPE_PUBLISHABLE_KEY'];
  if (!key) return { configured: false };
  return { configured: true, publishableKey: key };
}

// ─── createMySetupIntentAction ─────────────────────────────────────────────────

export type CreateMySetupIntentActionResult =
  | { ok: true; clientSecret: string; setupIntentId: string }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message?: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function createMySetupIntentAction(): Promise<CreateMySetupIntentActionResult> {
  const session = await auth();
  try {
    return await createMySetupIntent(session);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── saveMyPaymentMethodAction ─────────────────────────────────────────────────

export type SaveMyPaymentMethodActionResult =
  | { ok: true; paymentMethod: SavedPaymentMethodView }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message?: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function saveMyPaymentMethodAction(paymentMethodId: string): Promise<SaveMyPaymentMethodActionResult> {
  const session = await auth();
  try {
    return await saveMyPaymentMethod(session, { paymentMethodId });
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── setMyAutopayAction ─────────────────────────────────────────────────────────

export type SetMyAutopayActionResult =
  | { ok: true; setting: AutopaySettingView }
  | { ok: false; reason: 'pm_required' | 'pm_not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function setMyAutopayAction(
  enabled: boolean,
  defaultPaymentMethodId?: string,
): Promise<SetMyAutopayActionResult> {
  const session = await auth();
  try {
    return await setMyAutopay(session, { enabled, defaultPaymentMethodId });
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── payMyInvoiceAction ─────────────────────────────────────────────────────────

export type PayMyInvoiceActionResult =
  | { ok: true; paymentIntentId: string; clientSecret: string; status: string; alreadyExists: boolean }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_finalized' }
  | { ok: false; reason: 'provider_error'; message?: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function payMyInvoiceAction(invoiceId: string): Promise<PayMyInvoiceActionResult> {
  const session = await auth();
  try {
    return await payMyInvoice(session, { invoiceId });
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Slice P1.4 — Calendar feed actions
//
// SELF-SCOPED (unchanged pattern): subject is ALWAYS session.userId, enforced
// inside the @aeroops/api command. createCalendarFeedAction is GENERIC over
// scope — it also backs the Fleet-detail "get this aircraft's calendar feed"
// card (apps/web/app/o/[slug]/(shell)/fleet/_components/aircraft-calendar-
// feed-card.tsx imports this same action), since a feed is always owned by
// the caller regardless of which page created it. The feed_token itself is a
// bearer secret — this file never logs it, only passes it through to the
// client component that renders the copyable URL.
// ════════════════════════════════════════════════════════════════════════════════

function isValidationError(err: unknown): err is { message: string; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

export type ValidationErrorResult = { error: 'validation'; message: string };

/** Serialized CalendarFeedView — Dates replaced with ISO strings. */
export interface SerializedCalendarFeedView {
  id: string;
  scope: 'my_reservations' | 'aircraft';
  resourceId: string | null;
  feedToken: string;
  active: boolean;
  createdAt: string;
}

function serializeCalendarFeed(f: CalendarFeedView): SerializedCalendarFeedView {
  return {
    id: f.id,
    scope: f.scope,
    resourceId: f.resourceId,
    feedToken: f.feedToken,
    active: f.active,
    createdAt: f.createdAt.toISOString(),
  };
}

// ─── createCalendarFeedAction ─────────────────────────────────────────────────

export type CreateCalendarFeedActionResult =
  | { ok: true; feed: SerializedCalendarFeedView }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * createCalendarFeedAction — scope='my_reservations' (self, no resourceId) or
 * scope='aircraft' (staff, resourceId required — the Fleet-detail card).
 * Capability gating happens INSIDE createCalendarFeed, keyed off scope.
 */
export async function createCalendarFeedAction(
  input: { scope: 'my_reservations' } | { scope: 'aircraft'; resourceId: string },
): Promise<CreateCalendarFeedActionResult> {
  const session = await auth();
  try {
    const result = await createCalendarFeed(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, feed: serializeCalendarFeed(result.feed) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── listMyCalendarFeedsAction ─────────────────────────────────────────────────

export type ListMyCalendarFeedsActionResult =
  | { ok: true; feeds: SerializedCalendarFeedView[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listMyCalendarFeedsAction(): Promise<ListMyCalendarFeedsActionResult> {
  const session = await auth();
  try {
    const feeds = await listMyCalendarFeeds(session);
    return { ok: true, feeds: feeds.map(serializeCalendarFeed) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── revokeCalendarFeedAction ─────────────────────────────────────────────────

export type RevokeCalendarFeedActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function revokeCalendarFeedAction(feedId: string): Promise<RevokeCalendarFeedActionResult> {
  const session = await auth();
  try {
    return await revokeCalendarFeed(session, { feedId });
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── regenerateCalendarFeedAction ──────────────────────────────────────────────

export type RegenerateCalendarFeedActionResult =
  | { ok: true; feed: SerializedCalendarFeedView }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function regenerateCalendarFeedAction(
  feedId: string,
): Promise<RegenerateCalendarFeedActionResult> {
  const session = await auth();
  try {
    const result = await regenerateCalendarFeed(session, { feedId });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, feed: serializeCalendarFeed(result.feed) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Slice P2 — Pilot logbook actions (portal self-scope)
//
// COMPLIANCE HARD LINE: a CONVENIENCE VIEW of the operator's dispatch history —
// NOT the pilot's official/certified §61.51 logbook of record. Makes NO
// currency/experience/§61.51/§61.57 determination. See the verbatim disclaimer
// rendered on portal/logbook/page.tsx.
//
// SELF-SCOPING (unchanged pattern): NO row-identifying input — the subject is
// ALWAYS session.userId, enforced inside the @aeroops/api command
// (portal:access + self-scope).
// ════════════════════════════════════════════════════════════════════════════════

export interface PilotLogDateBounds {
  from?: string;
  to?: string;
}

export type GetMyPilotLogActionResult =
  | { ok: true; log: SerializedPilotLog }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getMyPilotLogAction(
  input?: PilotLogDateBounds,
): Promise<GetMyPilotLogActionResult> {
  const session = await auth();
  try {
    const log = await getMyPilotLog(session, input);
    return { ok: true, log: serializePilotLog(log) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

export type ExportMyPilotLogCsvActionResult =
  | { ok: true; filename: string; csv: string }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function exportMyPilotLogCsvAction(
  input?: PilotLogDateBounds,
): Promise<ExportMyPilotLogCsvActionResult> {
  const session = await auth();
  try {
    const result = await exportMyPilotLogCsv(session, input);
    return { ok: true, filename: result.filename, csv: result.csv };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
