/**
 * series-preview-panel.tsx — Live preview of what a series would create.
 *
 * States:
 *   idle       → hidden
 *   loading    → skeleton / spinner
 *   populated  → summary + per-date list with badges + notices
 *   error      → inline error message
 *
 * Reuses ConflictHit / PolicyViolationView rendering from 2a's conflict-banner
 * via the shared helpers exported from conflict-banner.tsx (PolicyViolationBullet,
 * conflict hit bullet formatting). We inline the minimal renderers here to stay
 * within our file boundary and avoid re-exporting internals from conflict-banner.
 *
 * A11y: aria-live="polite" on the container so screen readers announce updates.
 */
'use client';

import * as React from 'react';
import { Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { SeriesPreviewState } from '../_hooks/use-series-preview';
import type { PreviewSeriesResult, PreviewSeriesOccurrenceReport, ConflictHit, PolicyViolationView } from '@aeroops/api';

interface SeriesPreviewPanelProps {
  state: SeriesPreviewState;
  preview: PreviewSeriesResult | null;
  errorMessage: string | null;
  /**
   * tz — IANA timezone the operator selected for this series (e.g. "America/Chicago").
   * When provided, occurrence dates/times are formatted in the scheduling timezone
   * rather than the browser's local timezone (which may differ when the operator
   * explicitly confirms a different tz — spec §4 "operator-confirmable" field).
   */
  tz?: string;
}

// ─── Local rendering helpers (mirrors conflict-banner.tsx logic) ──────────────

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

function ConflictHitBullet({ hit, tz }: { hit: ConflictHit; tz?: string }) {
  return (
    <li className="text-xs">
      {hit.resourceDisplayName} is booked {formatTimeRangeTz(hit.start, hit.end, tz)}
    </li>
  );
}

function PolicyBullet({ v, tz }: { v: PolicyViolationView; tz?: string }) {
  switch (v.kind) {
    case 'max_duration_exceeded':
      return (
        <li className="text-xs">
          Max booking length is {v.limitMinutes} min; this is {v.actualMinutes} min.
        </li>
      );
    case 'too_far_in_advance':
      return (
        <li className="text-xs">
          Bookings can be made at most {v.limitDays} days ahead.
        </li>
      );
    case 'insufficient_lead_time':
      return (
        <li className="text-xs">
          Bookings require at least {v.requiredMinutes} min lead time.
        </li>
      );
    case 'blackout_overlap':
      return (
        <li className="text-xs">
          {v.resourceDisplayName} is unavailable {formatTime(new Date(v.blackoutStart), tz)}–{formatTime(new Date(v.blackoutEnd), tz)} (blackout).
        </li>
      );
    default:
      return null;
  }
}

function OccurrenceBadge({ occ }: { occ: PreviewSeriesOccurrenceReport }) {
  if (occ.result === 'would_create') {
    return (
      <Badge variant="default" className="shrink-0 text-xs">
        {occ.dstAdjusted ? 'Would create (DST)' : 'Would create'}
      </Badge>
    );
  }

  // would_skip
  const label =
    occ.reason === 'conflict_and_policy'
      ? 'Conflict + policy'
      : occ.reason === 'conflict'
        ? 'Conflict'
        : occ.reason === 'policy'
          ? 'Policy'
          : 'Skip';

  return (
    <Badge variant="destructive" className="shrink-0 text-xs">
      {label}
    </Badge>
  );
}

function OccurrenceRow({ occ, tz }: { occ: PreviewSeriesOccurrenceReport; tz?: string }) {
  const hasConflicts = (occ.conflicts?.length ?? 0) > 0;
  const hasViolations = (occ.violations?.length ?? 0) > 0;
  const showReasons = occ.result === 'would_skip' && (hasConflicts || hasViolations);

  const dateLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(tz ? { timeZone: tz } : {}),
  }).format(occ.startAt);

  const timeLabel = formatTimeRangeTz(occ.startAt, occ.endAt, tz);

  return (
    <li className="py-2 border-b border-slate-100 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">
            {dateLabel}
          </p>
          <p className="text-xs text-slate-500">{timeLabel}</p>
        </div>
        <OccurrenceBadge occ={occ} />
      </div>
      {showReasons && (
        <div className="mt-1 pl-1">
          {hasConflicts && (
            <ul className="list-disc list-inside text-red-700">
              {occ.conflicts!.map((h, i) => (
                <ConflictHitBullet key={`${h.resourceId}-${i}`} hit={h} tz={tz} />
              ))}
            </ul>
          )}
          {hasViolations && (
            <ul className="list-disc list-inside text-red-700">
              {occ.violations!.map((v, i) => (
                <PolicyBullet key={`${v.resourceId}-${v.kind}-${i}`} v={v} tz={tz} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function SeriesPreviewPanel({ state, preview, errorMessage, tz }: SeriesPreviewPanelProps) {
  if (state === 'idle') return null;

  return (
    <div aria-live="polite" aria-label="Series preview">
      {state === 'loading' && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Checking availability…</span>
          </div>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}

      {state === 'error' && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-800" role="status">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            {errorMessage ?? 'Preview failed. You can still try submitting.'}
          </AlertDescription>
        </Alert>
      )}

      {state === 'populated' && preview && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
          {/* Summary line.
              Denominator = occurrences.length (= wouldCreate + wouldSkip), which
              self-reconciles: wouldCreate + wouldSkip === occurrences.length.
              DST-nonexistent dates are in a SEPARATE skippedLocalDates array and
              are surfaced via the dedicated DST notice below — not folded into the
              headline denominator (mirrors series-create-result.tsx convention). */}
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-800">
              Will create{' '}
              <span className="text-green-700">{preview.wouldCreateCount}</span> of{' '}
              {preview.occurrences.length} occurrence(s)
              {preview.wouldSkipCount > 0 && (
                <>
                  {' '}
                  (<span className="text-red-700">{preview.wouldSkipCount} skipped</span>)
                </>
              )}
            </p>
          </div>

          {/* Cap truncation notice */}
          {preview.truncatedByCap && (
            <Alert className="border-amber-200 bg-amber-50 text-amber-800 py-2" role="status">
              <Info className="h-4 w-4" aria-hidden="true" />
              <AlertDescription className="text-xs">
                Limited to 52 occurrences maximum. Some dates beyond the cap were excluded.
              </AlertDescription>
            </Alert>
          )}

          {/* DST-skip notice — separate from the headline count (these are dates
              that were dropped before expansion, not would_skip occurrences). */}
          {(preview.skippedLocalDates?.length ?? 0) > 0 && (
            <Alert className="border-amber-200 bg-amber-50 text-amber-800 py-2" role="status">
              <Info className="h-4 w-4" aria-hidden="true" />
              <AlertDescription className="text-xs">
                {preview.skippedLocalDates.length} date(s) skipped due to DST — the local time does not exist on those dates.
              </AlertDescription>
            </Alert>
          )}

          {/* Per-occurrence list */}
          {preview.occurrences.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                Occurrences
              </p>
              <ul
                className="max-h-64 overflow-y-auto divide-y divide-slate-100 rounded border border-slate-200 bg-white"
                aria-label="Occurrence list"
              >
                {preview.occurrences.map((occ) => (
                  <OccurrenceRow key={occ.index} occ={occ} tz={tz} />
                ))}
              </ul>
            </div>
          )}

          {preview.occurrences.length === 0 && (
            <p className="text-sm text-slate-500">
              No future occurrences match these settings. The series will still be created.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
