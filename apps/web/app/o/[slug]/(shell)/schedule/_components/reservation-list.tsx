/**
 * reservation-list.tsx — Client component managing the reservation list state.
 *
 * Receives initial reservations + resources from the RSC page. Handles:
 * - Optimistic removal on cancel (removes from local state immediately).
 * - Success toast (dismissible Alert) after booking redirect.
 * - Empty state + first-run banner.
 * - Error state.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Calendar, PlaneTakeoff } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ReservationCard } from './reservation-card';
import { buildResourceMap } from '../_utils/resource-map';
import { formatTimeRange } from '../_utils/format-time';
import type { ReservationRow, ResourceRow } from '@aeroops/api';

interface ReservationListProps {
  reservations: ReservationRow[];
  resources: ResourceRow[];
  canCreate: boolean;
  canManageResources: boolean;
  /** Date in YYYY-MM-DD format for the + New Reservation link */
  dateStr: string;
  slug: string;
  error?: boolean;
}

export function ReservationList({
  reservations: initialReservations,
  resources,
  canCreate,
  canManageResources,
  dateStr,
  slug,
  error,
}: ReservationListProps) {
  const searchParams = useSearchParams();
  const [reservations, setReservations] = React.useState(initialReservations);
  const [successVisible, setSuccessVisible] = React.useState(
    searchParams.get('success') === '1',
  );

  // Success banner: spec §4 copy "Reservation booked for [date] [start]–[end]."
  const successDate = searchParams.get('date') ?? dateStr;
  const successStart = searchParams.get('start') ?? '';
  const successEnd = searchParams.get('end') ?? '';

  const resourceMap = React.useMemo(() => buildResourceMap(resources), [resources]);

  const handleCancelled = React.useCallback((reservationId: string) => {
    setReservations((prev) =>
      prev.map((r) =>
        r.id === reservationId ? { ...r, status: 'cancelled' as const } : r,
      ),
    );
  }, []);

  const noResources = resources.length === 0;

  return (
    <div className="space-y-4">
      {/* Success banner from redirect */}
      {successVisible && (
        <Alert className="border-green-200 bg-green-50 text-green-800" role="status">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>
              Reservation booked for {successDate}
              {successStart && successEnd ? ` ${successStart}–${successEnd}` : ''}.
            </span>
            <button
              type="button"
              onClick={() => setSuccessVisible(false)}
              className="text-green-700 hover:text-green-900 text-sm underline shrink-0"
              aria-label="Dismiss success message"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* First-run banner: no resources at all */}
      {noResources && canManageResources && !error && (
        <Alert className="border-sky-200 bg-sky-50 text-sky-800" role="status">
          <AlertDescription>
            No resources have been added yet.{' '}
            <Link
              href={`/o/${slug}/schedule/resources`}
              className="underline font-medium hover:no-underline"
            >
              Add aircraft and instructors
            </Link>{' '}
            before creating reservations.
          </AlertDescription>
        </Alert>
      )}

      {/* Error state */}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Could not load reservations. Try refreshing the page.
          </AlertDescription>
        </Alert>
      )}

      {/* Reservation list */}
      {!error && reservations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
          <Calendar className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-slate-600">No reservations on this date.</p>
          {canCreate && (
            <p className="text-sm text-slate-500">
              Book one with{' '}
              <Link
                href={`/o/${slug}/schedule/new?date=${dateStr}`}
                className="text-sky-600 underline hover:no-underline"
              >
                + New Reservation
              </Link>{' '}
              above.
            </p>
          )}
          {!canCreate && noResources && canManageResources && (
            <p className="text-sm text-slate-500">
              <Link
                href={`/o/${slug}/schedule/resources`}
                className="text-sky-600 underline hover:no-underline"
              >
                Add a resource
              </Link>{' '}
              to enable booking.
            </p>
          )}
        </div>
      ) : (
        !error && (
          <div className="space-y-3">
            {reservations.map((r) => (
              <ReservationCard
                key={r.id}
                reservation={r}
                resourceMap={resourceMap}
                canCancel={canCreate}
                onCancelled={handleCancelled}
                seriesId={r.seriesId}
                slug={slug}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}
