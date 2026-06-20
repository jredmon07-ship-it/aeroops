/**
 * series-create-result.tsx — Post-submit result screen for createSeries.
 *
 * Spec §4.1: "Created X, skipped Z" header + list grouped by result (created /
 * skipped) with per-occurrence reasons. Reuses ConflictHit / PolicyViolationView
 * rendering (2a pattern). Links created occurrences to the schedule day view.
 *
 * A11y: aria-live="assertive" on mount announcement, role=status heading.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { CreateSeriesResult, SeriesOccurrenceReport, ConflictHit, PolicyViolationView } from '@aeroops/api';

interface SeriesCreateResultProps {
  result: CreateSeriesResult;
  slug: string;
  onReset: () => void;
}

// ─── Inline rendering helpers (mirrors conflict-banner pattern) ───────────────

/** Format a time in the given IANA tz (falls back to browser tz if omitted). */
function formatTime(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(tz ? { timeZone: tz } : {}),
  }).format(d);
}

/** Format a time range as "HH:mm – HH:mm" in the given IANA tz. */
function formatTimeRangeTz(start: Date, end: Date, tz?: string): string {
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
 * Derive a YYYY-MM-DD string from a Date in the given IANA timezone.
 * Uses Intl.DateTimeFormat to extract year/month/day in the scheduling tz
 * rather than the browser's local tz (avoids midnight-crossover bugs when
 * the operator's selected tz differs from the browser tz).
 */
function toDateStrTz(d: Date, tz?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(tz ? { timeZone: tz } : {}),
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

function ConflictHitBullet({ hit, tz }: { hit: ConflictHit; tz?: string }) {
  return (
    <li className="text-xs text-red-700">
      {hit.resourceDisplayName} is booked {formatTimeRangeTz(hit.start, hit.end, tz)}
    </li>
  );
}

function PolicyBullet({ v, tz }: { v: PolicyViolationView; tz?: string }) {
  switch (v.kind) {
    case 'max_duration_exceeded':
      return (
        <li className="text-xs text-red-700">
          Max booking length is {v.limitMinutes} min; this is {v.actualMinutes} min.
        </li>
      );
    case 'too_far_in_advance':
      return (
        <li className="text-xs text-red-700">
          Bookings can be made at most {v.limitDays} days ahead.
        </li>
      );
    case 'insufficient_lead_time':
      return (
        <li className="text-xs text-red-700">
          Bookings require at least {v.requiredMinutes} min lead time.
        </li>
      );
    case 'blackout_overlap':
      return (
        <li className="text-xs text-red-700">
          {v.resourceDisplayName} is unavailable {formatTime(new Date(v.blackoutStart), tz)}–{formatTime(new Date(v.blackoutEnd), tz)} (blackout).
        </li>
      );
    default:
      return null;
  }
}

function OccurrenceResultRow({
  occ,
  slug,
  tz,
}: {
  occ: SeriesOccurrenceReport;
  slug: string;
  tz?: string;
}) {
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(tz ? { timeZone: tz } : {}),
  }).format(occ.startAt);

  const timeLabel = formatTimeRangeTz(occ.startAt, occ.endAt, tz);

  // Derive YYYY-MM-DD in the scheduling tz (not browser tz) so the day-link
  // navigates to the correct schedule date when the scheduling tz differs from
  // the browser tz (e.g. an America/Chicago series viewed from a UTC browser).
  const dateStr = toDateStrTz(occ.startAt, tz);

  const hasConflicts = (occ.conflicts?.length ?? 0) > 0;
  const hasViolations = (occ.violations?.length ?? 0) > 0;

  return (
    <li className="py-2.5 border-b border-slate-100 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">
            {occ.result === 'created' && occ.reservationId ? (
              <Link
                href={`/o/${slug}/schedule?date=${dateStr}`}
                className="hover:underline text-brand"
                aria-label={`View ${dateLabel} reservation on schedule`}
              >
                {dateLabel}
              </Link>
            ) : (
              dateLabel
            )}
          </p>
          <p className="text-xs text-slate-500">{timeLabel}</p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {occ.result === 'created' ? (
            <Badge variant="default" className="text-xs">
              Created
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-xs">
              Skipped
            </Badge>
          )}
        </div>
      </div>

      {/* Skip reasons */}
      {occ.result === 'skipped' && (hasConflicts || hasViolations) && (
        <div className="mt-1 pl-1">
          {hasConflicts && (
            <>
              <p className="text-xs font-medium text-red-700">Conflict(s):</p>
              <ul className="list-disc list-inside">
                {occ.conflicts!.map((h, i) => (
                  <ConflictHitBullet key={`${h.resourceId}-${i}`} hit={h} tz={tz} />
                ))}
              </ul>
            </>
          )}
          {hasViolations && (
            <>
              <p className="text-xs font-medium text-red-700">Booking rules not met:</p>
              <ul className="list-disc list-inside">
                {occ.violations!.map((v, i) => (
                  <PolicyBullet key={`${v.resourceId}-${v.kind}-${i}`} v={v} tz={tz} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function SeriesCreateResult({ result, slug, onReset }: SeriesCreateResultProps) {
  const created = result.occurrences.filter((o) => o.result === 'created');
  const skipped = result.occurrences.filter((o) => o.result === 'skipped');

  // Resolve the series' IANA tz from the series row (supports both camelCase and
  // snake_case variants of SeriesRow — see types.ts dual-form interface).
  const seriesTz: string | undefined =
    (result.series.ianaTz ?? result.series.iana_tz) || undefined;

  return (
    <div
      role="status"
      aria-live="assertive"
      aria-label="Series creation result"
      className="space-y-5 max-w-lg"
    >
      {/* Header summary */}
      <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4">
        <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold text-green-900">
            Series created: {result.createdCount} booked, {result.skippedCount} skipped
          </p>
          <p className="text-sm text-green-700 mt-0.5">
            The recurring series has been saved. Created occurrences are on the schedule.
          </p>
        </div>
      </div>

      {/* Cap truncation notice */}
      {result.truncatedByCap && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-800" role="status">
          <Info className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">
            Limited to 52 occurrences maximum. Dates beyond the cap were excluded.
          </AlertDescription>
        </Alert>
      )}

      {/* DST-skip notice */}
      {(result.skippedLocalDates?.length ?? 0) > 0 && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-800" role="status">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">
            {result.skippedLocalDates.length} date(s) skipped — the local start time does not exist on those dates due to DST.
          </AlertDescription>
        </Alert>
      )}

      {/* All-skipped notice */}
      {result.createdCount === 0 && result.skippedCount > 0 && (
        <Alert variant="destructive" role="alert">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            All occurrences were skipped due to conflicts or policy. The series record was still created.
          </AlertDescription>
        </Alert>
      )}

      {/* Created occurrences */}
      {created.length > 0 && (
        <section aria-label="Created occurrences">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-800">
              Booked ({created.length})
            </h2>
          </div>
          <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
            {created.map((occ) => (
              <OccurrenceResultRow key={occ.index} occ={occ} slug={slug} tz={seriesTz} />
            ))}
          </ul>
        </section>
      )}

      {/* Skipped occurrences */}
      {skipped.length > 0 && (
        <section aria-label="Skipped occurrences">
          <div className="flex items-center gap-2 mb-2">
            <XCircle className="h-4 w-4 text-red-500" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-800">
              Skipped ({skipped.length})
            </h2>
          </div>
          <ul className="divide-y divide-slate-100 rounded border border-red-100 bg-white">
            {skipped.map((occ) => (
              <OccurrenceResultRow key={occ.index} occ={occ} slug={slug} tz={seriesTz} />
            ))}
          </ul>
        </section>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end pt-2">
        <Button variant="outline" onClick={onReset} type="button">
          Book another reservation
        </Button>
        <Button asChild>
          <Link href={`/o/${slug}/schedule`}>Back to Schedule</Link>
        </Button>
      </div>
    </div>
  );
}
