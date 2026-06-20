/**
 * series-occurrence-list.tsx — Client component showing a series' occurrences
 * with cancel-series action.
 *
 * Spec §4.2 (Slice 2b): Occurrence list (start–end local, status booked/cancelled/past).
 * Also renders the cancel-series dialog trigger and success/error feedback.
 *
 * States: empty / populated / success (toast inline) / error.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Calendar } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { CancelSeriesDialog } from './cancel-series-dialog';
import type { ReservationRow, SeriesRow } from '@aeroops/api';

// ─── Tz-aware formatting helpers ─────────────────────────────────────────────

/**
 * Format a time range as "HH:mm – HH:mm" in the given IANA tz.
 * Falls back to browser tz when tz is undefined/null (matching legacy behaviour).
 */
function formatTimeRangeTz(start: Date, end: Date, tz?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(tz ? { timeZone: tz } : {}),
  };
  const fmt = new Intl.DateTimeFormat(undefined, opts);
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * Format a Date as a long human-readable date string in the given IANA tz.
 * e.g. "Monday, June 16, 2026"
 */
function formatDateTz(date: Date, tz?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(tz ? { timeZone: tz } : {}),
  }).format(date);
}

interface SeriesOccurrenceListProps {
  series: SeriesRow;
  occurrences: ReservationRow[];
  slug: string;
  canCancel: boolean;
}

/** Derive human-readable status + badge variant per occurrence. */
function occurrenceStatus(r: ReservationRow): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
} {
  const now = new Date();
  if (r.status === 'cancelled') {
    return { label: 'Cancelled', variant: 'secondary' };
  }
  if (r.endAt < now) {
    return { label: 'Past', variant: 'outline' };
  }
  return { label: 'Booked', variant: 'default' };
}

/** Count future booked occurrences (for the cancel dialog copy). */
function countFutureBooked(occurrences: ReservationRow[]): number {
  const now = new Date();
  return occurrences.filter(
    (r) => r.status === 'booked' && r.startAt > now,
  ).length;
}

export function SeriesOccurrenceList({
  series,
  occurrences,
  slug,
  canCancel,
}: SeriesOccurrenceListProps) {
  // Resolve IANA tz from the series row (supports both camelCase and snake_case
  // variants of SeriesRow — see types.ts dual-form interface).
  const seriesTz: string | null = (series.ianaTz ?? series.iana_tz) || null;

  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  // After cancellation, mark remaining booked-future ones locally as cancelled
  const [localOccurrences, setLocalOccurrences] = React.useState(occurrences);
  const [seriesCancelled, setSeriesCancelled] = React.useState(
    series.status === 'cancelled',
  );

  const futureBookedCount = countFutureBooked(localOccurrences);

  const handleCancelSuccess = (cancelledCount: number) => {
    setErrorMsg(null);
    setSeriesCancelled(true);
    // Optimistically mark future booked occurrences as cancelled
    const now = new Date();
    setLocalOccurrences((prev) =>
      prev.map((r) =>
        r.status === 'booked' && r.startAt > now
          ? { ...r, status: 'cancelled' as const }
          : r,
      ),
    );
    const occLabel =
      cancelledCount === 1 ? '1 occurrence' : `${cancelledCount} occurrences`;
    setSuccessMsg(`Series cancelled. ${occLabel} cancelled.`);
  };

  const handleCancelError = (message: string) => {
    setErrorMsg(message);
  };

  return (
    <div className="space-y-4">
      {/* Success feedback */}
      {successMsg && (
        <Alert
          className="border-green-200 bg-green-50 text-green-800"
          role="status"
          aria-live="polite"
        >
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{successMsg}</span>
            <button
              type="button"
              onClick={() => setSuccessMsg(null)}
              className="text-green-700 hover:text-green-900 text-sm underline shrink-0"
              aria-label="Dismiss message"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* Error feedback */}
      {errorMsg && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="underline text-sm shrink-0"
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* Cancel series action — only shown for active series with future occurrences */}
      {!seriesCancelled && futureBookedCount > 0 && (
        <div className="flex justify-end">
          <CancelSeriesDialog
            seriesId={series.id}
            futureBookedCount={futureBookedCount}
            canCancel={canCancel}
            onSuccess={handleCancelSuccess}
            onError={handleCancelError}
          />
        </div>
      )}

      {/* Cancelled series notice */}
      {seriesCancelled && (
        <Alert
          className="border-slate-200 bg-slate-50 text-slate-700"
          role="status"
        >
          <AlertDescription>
            This series has been cancelled. No new occurrences will be created.
          </AlertDescription>
        </Alert>
      )}

      {/* Occurrence list */}
      {localOccurrences.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-16 text-center space-y-2"
          role="status"
        >
          <Calendar className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-slate-600">No occurrences found for this series.</p>
          <Link
            href={`/o/${slug}/schedule`}
            className="text-sm text-brand underline hover:no-underline"
          >
            Back to Schedule
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {localOccurrences.map((r, idx) => {
            const { label, variant } = occurrenceStatus(r);
            const timeRange = formatTimeRangeTz(r.startAt, r.endAt, seriesTz);
            const dateLabel = formatDateTz(r.startAt, seriesTz);
            return (
              <article
                key={r.id}
                aria-label={`Occurrence ${idx + 1}: ${dateLabel} ${timeRange}, ${label}`}
                className="rounded-md border border-border bg-white p-3 flex items-center justify-between gap-3 shadow-sm"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="font-medium text-slate-900 text-sm truncate">
                    {dateLabel}
                  </p>
                  <p className="text-sm text-slate-600">{timeRange}</p>
                  {r.notes && (
                    <p className="text-xs text-slate-500 truncate">{r.notes}</p>
                  )}
                </div>
                <Badge variant={variant}>{label}</Badge>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
