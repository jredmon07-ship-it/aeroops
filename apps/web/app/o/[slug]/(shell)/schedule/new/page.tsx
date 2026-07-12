/**
 * schedule/new/page.tsx — New Reservation RSC page.
 *
 * SERVER-SIDE RBAC GATE:
 *   requireCapability(session, 'schedule:create_reservation') is called first.
 *   Any role without this capability is redirected to no-access, even if they
 *   hit the URL directly. Hiding the nav link is cosmetic only.
 *
 * DATA:
 *   listResources(session, {}) returns active resources only (includeInactive
 *   defaults to false). Resources are passed to the client form as props.
 *
 * STATES:
 *   No session          → redirect to login
 *   Forbidden           → redirect to no-access
 *   No resources (empty) → first-run empty state (rendered server-side)
 *   Has resources       → NewReservationForm client component
 *   listResources error → graceful error (form still renders, list is empty)
 *
 * BOUNDARY: imports only from @aeroops/api — never @aeroops/db.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PlaneTakeoff } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability, listResources } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { NewReservationForm } from './_components/new-reservation-form';

// NOTE: The "Back to Schedule" button is rendered inside NewReservationForm
// (a client component) so it participates in the dirty-form guard (spec §4).
// The RSC page only renders the <h1> heading.

interface NewReservationPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string }>;
}

export default async function NewReservationPage({
  params,
  searchParams,
}: NewReservationPageProps) {
  const { slug } = await params;
  const { date: dateParam } = await searchParams;
  const session = await auth();

  // ── Server-side RBAC gate ───────────────────────────────────────────────────
  try {
    requireCapability(session, 'schedule:create_reservation');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') {
      redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    }
    if (action === 'login') {
      redirect(`/o/${slug}/login`);
    }
    throw err;
  }

  // session is guaranteed non-null after requireCapability succeeded.
  // UI-only check for "Add a Resource" button in the first-run empty state.
  // Real gate is requireCapability in createResourceAction.
  const canManageResources = hasCapability(session, 'schedule:manage_resources');

  // ── Fetch active resources ─────────────────────────────────────────────────
  let resources: Awaited<ReturnType<typeof listResources>> = [];
  let resourcesError = false;

  try {
    resources = await listResources(session, {});
  } catch {
    // Non-fatal: we render an error notice but do not block the page.
    resourcesError = true;
  }

  // Separate by kind — active only (listResources returns active by default).
  const aircraft = resources.filter((r) => r.kind === 'aircraft');
  const instructors = resources.filter((r) => r.kind === 'instructor');
  const hasResources = aircraft.length > 0 || instructors.length > 0;

  // ── Validate / normalise the ?date= query param ────────────────────────────
  // Accept YYYY-MM-DD; fall back to '' (form defaults to today).
  const initialDate =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : '';

  return (
    <div className="space-y-6">
      {/* ── Page heading ──────────────────────────────────────────────────── */}
      {/* Note: "Back to Schedule" button lives in NewReservationForm for dirty-form
          guard — so no backHref here. */}
      <PageHeader title="New Reservation" />

      {/* ── Resource-fetch error notice ────────────────────────────────────── */}
      {resourcesError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Could not load resources. Try refreshing the page.
          </AlertDescription>
        </Alert>
      )}

      {/* ── First-run empty state — no resources added yet ─────────────────── */}
      {!resourcesError && !hasResources && (
        <EmptyState
          icon={PlaneTakeoff}
          title="No resources to book yet."
          body="An administrator must add at least one aircraft or instructor before you can create a reservation."
          cta={
            canManageResources ? (
              <Button asChild variant="outline">
                <Link href={`/o/${slug}/schedule/resources`}>Add a Resource</Link>
              </Button>
            ) : undefined
          }
        />
      )}

      {/* ── Booking form — rendered when resources exist ────────────────────── */}
      {(hasResources || resourcesError) && (
        <NewReservationForm
          resources={resources}
          slug={slug}
          initialDate={initialDate}
          canManageResources={canManageResources}
          backHref={`/o/${slug}/schedule${initialDate ? `?date=${initialDate}` : ''}`}
        />
      )}
    </div>
  );
}
