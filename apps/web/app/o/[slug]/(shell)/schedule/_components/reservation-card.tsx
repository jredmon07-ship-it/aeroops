/**
 * reservation-card.tsx — Single reservation card for the list view.
 *
 * Spec §3: article with aria-label, time range, resource names,
 * notes, status badge, and conditional cancel button.
 */
'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CancelReservationDialog } from './cancel-reservation-dialog';
import { formatTimeRange } from '../_utils/format-time';
import { sortResourceIds } from '../_utils/resource-map';
import type { ReservationRow, ResourceRow } from '@aeroops/api';

interface ReservationCardProps {
  reservation: ReservationRow;
  resourceMap: Map<string, ResourceRow>;
  canCancel: boolean;
  onCancelled: (reservationId: string) => void;
}

export function ReservationCard({
  reservation,
  resourceMap,
  canCancel,
  onCancelled,
}: ReservationCardProps) {
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const timeRange = formatTimeRange(reservation.startAt, reservation.endAt);
  const sortedIds = sortResourceIds(reservation.resourceIds, resourceMap);

  const resourceNames = sortedIds
    .map((id) => {
      const row = resourceMap.get(id);
      return row ? row.displayName : 'Unknown resource';
    })
    .join(', ');

  const ariaLabel = `Reservation ${timeRange}, ${resourceNames}, ${reservation.status}`;

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
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm space-y-2"
    >
      {/* Time + Status badge */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-900">{timeRange}</span>
        <Badge variant={reservation.status === 'booked' ? 'default' : 'secondary'}>
          {reservation.status === 'booked' ? 'Booked' : 'Cancelled'}
        </Badge>
      </div>

      {/* Resource names — aircraft before instructor */}
      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
        {sortedIds.map((id) => {
          const row = resourceMap.get(id);
          if (!row) {
            return (
              <span key={id} className="text-sm text-slate-400 italic">
                Unknown resource
              </span>
            );
          }
          return (
            <span key={id} className="text-sm text-slate-700">
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

      {/* Notes */}
      {reservation.notes && (
        <p className="text-sm text-slate-500">{reservation.notes}</p>
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
