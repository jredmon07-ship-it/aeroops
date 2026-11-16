/**
 * reservation-card.tsx — Single reservation card for the list view.
 *
 * Spec §3: article with aria-label, time range, resource names,
 * notes, status badge, and conditional cancel button.
 *
 * Slice 2b additive: optional seriesId prop — when provided, renders a "Repeats"
 * badge linking to /o/[slug]/schedule/series/[seriesId]. The badge is hidden when
 * seriesId is absent (listReservations does not return seriesId — see gap note in
 * actions.ts; future: add seriesId to ReservationRow in @aeroops/api).
 *
 * Migration 0051 additive: a booking made for a member reads "for Riley Member"
 * under its resources (and in the card's accessible name). A booking for no one
 * renders exactly as before.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CancelReservationDialog } from './cancel-reservation-dialog';
import { formatTimeRange } from '../_utils/format-time';
import { sortResourceIds } from '../_utils/resource-map';
import { bookedForLabel } from '@/lib/booked-for';
import type { ReservationRow, ResourceRow } from '@aeroops/api';

interface ReservationCardProps {
  reservation: ReservationRow;
  /**
   * The viewer's IANA zone the page resolved. The time range is read on its
   * clock, so the server's HTML and the browser's first render agree.
   */
  timeZone: string;
  resourceMap: Map<string, ResourceRow>;
  canCancel: boolean;
  onCancelled: (reservationId: string) => void;
  /**
   * seriesId — when set, renders a "Repeats" badge linking to the series view.
   * Not present on ReservationRow from listReservations (API gap: seriesId not
   * returned by listReservations). Pass when available (e.g. from series view).
   */
  seriesId?: string | null;
  /** slug — required when seriesId is set, to build the series link href. */
  slug?: string;
}

export function ReservationCard({
  reservation,
  timeZone,
  resourceMap,
  canCancel,
  onCancelled,
  seriesId,
  slug,
}: ReservationCardProps) {
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const timeRange = formatTimeRange(reservation.startAt, reservation.endAt, timeZone);
  const sortedIds = sortResourceIds(reservation.resourceIds, resourceMap);

  const resourceNames = sortedIds
    .map((id) => {
      const row = resourceMap.get(id);
      return row ? row.displayName : 'Unknown resource';
    })
    .join(', ');

  // Who the booking is for (migration 0051): "for Riley Member", or null.
  const bookedFor = bookedForLabel(reservation.memberDisplayName);

  const ariaLabel = bookedFor
    ? `Reservation ${timeRange}, ${resourceNames}, ${bookedFor}, ${reservation.status}`
    : `Reservation ${timeRange}, ${resourceNames}, ${reservation.status}`;

  const handleSuccess = () => {
    setErrorMsg(null);
    onCancelled(reservation.id);
  };

  const handleError = (message: string) => {
    setErrorMsg(message);
  };

  return (
    <article
      aria-label={ariaLabel}
      className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm space-y-2"
    >
      {/* Time + Status badge + optional Repeats badge */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-medium text-slate-900 dark:text-slate-100">{timeRange}</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Repeats badge — shown only when seriesId is available */}
          {seriesId && slug && (
            <Link
              href={`/o/${slug}/schedule/series/${seriesId}`}
              aria-label="View series occurrences"
              tabIndex={0}
            >
              <Badge variant="outline" className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                Repeats
              </Badge>
            </Link>
          )}
          <Badge variant={reservation.status === 'booked' ? 'default' : 'secondary'}>
            {reservation.status === 'booked' ? 'Booked' : 'Cancelled'}
          </Badge>
        </div>
      </div>

      {/* Resource names — aircraft before instructor */}
      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
        {sortedIds.map((id) => {
          const row = resourceMap.get(id);
          if (!row) {
            return (
              <span key={id} className="text-sm text-slate-500 dark:text-slate-400 italic">
                Unknown resource
              </span>
            );
          }
          return (
            <span key={id} className="text-sm text-slate-700 dark:text-slate-300">
              {row.kind === 'aircraft' && row.tailNumber ? (
                <>
                  <span className="font-mono text-sm">{row.tailNumber}</span>{' '}
                  {row.displayName}
                </>
              ) : (
                row.displayName
              )}
            </span>
          );
        })}
      </div>

      {/* The member the booking is for (migration 0051) */}
      {bookedFor && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{bookedFor}</p>
      )}

      {/* Notes */}
      {reservation.notes && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{reservation.notes}</p>
      )}

      {/* Error feedback */}
      {errorMsg && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}

      {/* Cancel button — only if can cancel and status is booked */}
      {canCancel && reservation.status === 'booked' && (
        <div className="flex justify-end pt-1">
          <CancelReservationDialog
            reservationId={reservation.id}
            timeRange={timeRange}
            resourceNames={resourceNames}
            onSuccess={handleSuccess}
            onError={handleError}
          />
        </div>
      )}
    </article>
  );
}
