/**
 * booking/page.tsx — Booking-request triage inbox (RSC).
 *
 * Route: /o/[slug]/booking
 * Capability gate: booking:triage (owner / manager / dispatcher).
 *
 * States:
 *   Loading           — Suspense skeleton (BookingInboxSkeleton).
 *   Populated         — Status tabs + rows table (BookingInbox).
 *   Empty per filter  — "No new requests" etc. inside the tabs.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — inline role panel (NOT a redirect) per deliverable spec.
 *
 * Primary action: "Mark contacted" on new requests.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 *
 * AUTHZ NOTE: requireCapability is the real gate (server-side).
 *   hasCapability here is purely cosmetic (determines which panel to render).
 *   A user without booking:triage hitting this URL directly gets the
 *   permission-denied panel — the API enforces the cap too.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Inbox, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listBookingRequestsAction } from './actions';
import { BookingInbox } from './_components/booking-inbox';
import { RetentionSettingsCard } from './_components/retention-settings';
import { PageHeader } from '@/components/ui/page-header';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function BookingInboxSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading booking requests">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-48" />
      </div>
      {/* Status tabs */}
      <div className="flex gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 p-1">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-sm" />
        ))}
      </div>
      {/* Rows */}
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900" />
        ))}
      </div>
    </div>
  );
}

// ─── Permission-denied panel ──────────────────────────────────────────────────

function PermissionDeniedPanel() {
  return (
    <div
      className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-2"
      role="status"
      aria-label="Permission denied"
    >
      <Inbox className="h-10 w-10 text-slate-300 mx-auto" aria-hidden="true" />
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Booking requests aren&apos;t available for your role.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Contact your administrator if you need access.
      </p>
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

interface BookingContentProps {
  slug: string;
  /** PB2.2 cosmetic gate — true when session has BOTH booking:triage + schedule:create_reservation. */
  canConvert: boolean;
  /**
   * PB-LR.A cosmetic gate — true when session has org:manage_settings.
   * The API enforces the cap; this prop controls whether the retention card renders.
   * UI only — gate enforced by requireCapability inside the server actions.
   */
  canManageSettings: boolean;
}

async function BookingContent({ slug, canConvert, canManageSettings }: BookingContentProps) {
  const result = await listBookingRequestsAction({ status: 'new' });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load booking requests. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/booking`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Retention settings card (org:manage_settings only) ───────────── */}
      {canManageSettings && (
        <RetentionSettingsCard canManageSettings={canManageSettings} slug={slug} />
      )}

      {/* ── Inbox ────────────────────────────────────────────────────────── */}
      <BookingInbox
        initial={result}
        slug={slug}
        canConvert={canConvert}
      />
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface BookingPageProps {
  params: Promise<{ slug: string }>;
}

export default async function BookingPage({ params }: BookingPageProps) {
  const { slug } = await params;
  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  // Per deliverable spec: permission-denied renders an INLINE panel (no redirect).
  // This is intentional — the API cap is the real gate; the panel is informational.
  let hasAccess = false;
  try {
    requireCapability(session, 'booking:triage');
    hasAccess = true;
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    // For unauthenticated (no session at all), redirect to login.
    if (action === 'login') redirect(`/o/${slug}/login`);
    // For forbidden (authenticated but wrong role), show the inline panel (no redirect).
    if (action !== 'forbidden') throw err;
  }

  // PB2.2 cosmetic gate — Convert button visible only when BOTH caps present.
  // The API is the real gate (requireCapability inside convertBookingRequest).
  const canConvert =
    hasAccess &&
    hasCapability(session, 'booking:triage') &&
    hasCapability(session, 'schedule:create_reservation');

  // PB-LR.A cosmetic gate — Retention card visible only when org:manage_settings is held.
  // UI only — gate enforced by requireCapability inside the server actions.
  const canManageSettings = hasCapability(session, 'org:manage_settings');

  return (
    <div className="space-y-4">
      {/* ── Heading ────────────────────────────────────────────────────────── */}
      <PageHeader title="Booking requests" />

      {/* ── Permission-denied panel (inline, no redirect) ──────────────────── */}
      {!hasAccess && <PermissionDeniedPanel />}

      {/* ── Inbox (Suspense so skeleton fires while the data loads) ──────── */}
      {hasAccess && (
        <Suspense fallback={<BookingInboxSkeleton />}>
          <BookingContent slug={slug} canConvert={canConvert} canManageSettings={canManageSettings} />
        </Suspense>
      )}
    </div>
  );
}
