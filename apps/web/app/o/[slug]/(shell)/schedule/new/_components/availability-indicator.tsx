/**
 * availability-indicator.tsx — Advisory "outside operating hours" badge for the
 * new-reservation form (Slice AV1.3).
 *
 * Shows per-aircraft availability results from previewAvailabilityAction:
 *   - hasWindows=false (no windows set)   -> nothing shown (card hidden)
 *   - hasWindows=true + wouldViolate=false -> "Within operating hours" chip (green)
 *   - hasWindows=true + wouldViolate=true  -> "Outside operating hours HH:MM-HH:MM" (amber)
 *
 * This indicator is ADVISORY only -- it never blocks the form, and it is
 * independent of whether the availability gate is enabled.
 *
 * [VERIFY-AV1-A]: Operating-hours availability is an OPERATOR SCHEDULING RULE.
 * NOT an FAA flight/duty-time, rest, or Part-117/135/121 determination.
 * Copy must never imply regulatory meaning.
 *
 * BOUNDARY: imports only from @aeroops/api, not @aeroops/db.
 */
'use client';

import * as React from 'react';
import { Clock, CheckCircle2, Loader2 } from 'lucide-react';
import type { PreviewAvailabilityResourceReport, AvailabilityHit } from '@aeroops/api';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type AvailabilityPreviewState =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'error';

interface AvailabilityIndicatorProps {
  state: AvailabilityPreviewState;
  perResource: PreviewAvailabilityResourceReport[];
  /** Map of resource id -> display name (tail number or display name). */
  resourceNames: Map<string, string>;
}

// ─── Format hit as "HH:MM-HH:MM" ──────────────────────────────────────────────

function formatHitRange(hit: AvailabilityHit): string {
  const startMs = hit.startUtcMs;
  const endMs = hit.endUtcMs;
  try {
    const fmt = (ms: number) =>
      new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms));
    return `${fmt(startMs)}–${fmt(endMs)}`;
  } catch {
    return '—';
  }
}

// ─── Per-resource badge ────────────────────────────────────────────────────────

function ResourceBadge({
  report,
  name,
}: {
  report: PreviewAvailabilityResourceReport;
  name: string;
}) {
  // If the resource has no windows set, the gate is inert -- don't show anything.
  if (!report.hasWindows) return null;

  if (!report.wouldViolate) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm"
        aria-label={`${name}: within operating hours`}
      >
        <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <span className="font-mono text-green-900">{name}</span>
          <p className="text-green-700 text-xs mt-0.5">Within operating hours</p>
        </div>
      </div>
    );
  }

  // Outside operating hours -- show uncovered sub-intervals.
  const hitDescriptions: string[] = [];
  for (const hit of report.hits) {
    hitDescriptions.push(`Outside operating hours (${formatHitRange(hit)})`);
  }
  if (hitDescriptions.length === 0) {
    hitDescriptions.push('Outside operating hours');
  }

  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm"
      role="status"
      aria-label={`${name}: ${hitDescriptions.join('; ')}`}
    >
      <Clock className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
      <div>
        <span className="font-mono text-amber-900">{name}</span>
        {hitDescriptions.map((desc, i) => (
          <p key={i} className="text-amber-800 text-xs mt-0.5">{desc}</p>
        ))}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function AvailabilityIndicator({
  state,
  perResource,
  resourceNames,
}: AvailabilityIndicatorProps) {
  if (state === 'idle') return null;

  if (state === 'loading') {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-500 py-1"
        role="status"
        aria-label="Checking operating hours"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        <span>Checking operating hours...</span>
      </div>
    );
  }

  if (state === 'error') {
    // Non-fatal -- silently hide on error (form still submits).
    return null;
  }

  // state === 'loaded'
  if (perResource.length === 0) return null;

  // Filter to aircraft only (those present in the resourceNames map).
  const aircraftReports = perResource.filter(
    (r) => resourceNames.has(r.resourceId) && r.hasWindows,
  );

  if (aircraftReports.length === 0) return null;

  return (
    <div className="space-y-1.5" aria-label="Operating hours indicators">
      <p className="text-xs text-slate-500 font-medium">
        Operating hours (advisory)
        {/* [VERIFY-AV1-A]: operator scheduling rule, NOT an FAA determination */}
      </p>
      {aircraftReports.map((r) => (
        <ResourceBadge
          key={r.resourceId}
          report={r}
          name={resourceNames.get(r.resourceId) ?? r.resourceId}
        />
      ))}
    </div>
  );
}
