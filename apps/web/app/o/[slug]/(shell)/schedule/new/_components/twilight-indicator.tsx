/**
 * twilight-indicator.tsx — Advisory civil-twilight day/night badge for the
 * new-reservation form (Slice 4a, §4a.3).
 *
 * Shows per-aircraft astronomy results from previewTwilight:
 *   • "normal" + no violation    → "Within daylight" chip (green/neutral).
 *   • "normal" + wouldViolate    → "Ends after civil dusk HH:MM" or
 *                                  "Starts before civil dawn HH:MM" (amber).
 *   • events=null (no coords)    → muted hint "Daylight unknown — base
 *                                  coordinates not set".
 *   • polar_day                  → "Polar day: sun does not set on this date".
 *   • polar_night                → "Polar night: sun does not rise on this date".
 *   • no_civil_twilight          → "No civil twilight on this date".
 *
 * This indicator is ADVISORY only — it never blocks the form, and it is
 * independent of whether the twilight gate is enabled.
 *
 * [VERIFY-4a-A]: Twilight indicator is astronomy-only. NOT an FAA night-currency
 * or §61.57 determination. Copy must never imply regulatory meaning.
 *
 * BOUNDARY: imports only from @aeroops/api, not @aeroops/db.
 */
'use client';

import * as React from 'react';
import { Sun, Moon, HelpCircle, Loader2 } from 'lucide-react';
import type { PreviewTwilightResourceReport } from '@aeroops/api';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Format epoch ms to local HH:MM string (for boundary times). */
function epochToLocal(epochMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(epochMs));
  } catch {
    return '—';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type TwilightPreviewState =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'error';

interface TwilightIndicatorProps {
  /** Current preview state. */
  state: TwilightPreviewState;
  /** Per-resource results from previewTwilightAction. */
  perResource: PreviewTwilightResourceReport[];
  /** Map of resource id → display name (tail number or display name). */
  resourceNames: Map<string, string>;
  /**
   * Candidate booking start (epoch ms). When provided, used to determine
   * whether the crossing is at dawn vs dusk. Optional — falls back to
   * boundary-existence check if absent.
   */
  candidateStartMs?: number;
  /**
   * Candidate booking end (epoch ms). When provided, used to determine
   * whether the crossing is at dawn vs dusk. Optional — falls back to
   * boundary-existence check if absent.
   */
  candidateEndMs?: number;
}

// ─── sub-components ───────────────────────────────────────────────────────────

function ResourceBadge({
  report,
  name,
  candidateStartMs,
  candidateEndMs,
}: {
  report: PreviewTwilightResourceReport;
  name: string;
  candidateStartMs?: number;
  candidateEndMs?: number;
}) {
  const { events, wouldViolate, classification } = report;

  // No coords / no home base → muted info hint
  if (!events && classification === null) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-sm"
        aria-label={`${name}: daylight unknown`}
      >
        <HelpCircle className="h-4 w-4 text-slate-400 dark:text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <span className="font-mono text-slate-700 dark:text-slate-300">{name}</span>
          <p className="text-slate-500 dark:text-slate-400 text-xs mt-0.5">
            Daylight unknown — base coordinates not set.
          </p>
        </div>
      </div>
    );
  }

  // Extreme-latitude classification (events may be null or classification is non-normal)
  if (classification && classification !== 'normal') {
    let copy: string;
    if (classification === 'polar_day') {
      copy = 'Polar day: sun does not set on this date.';
    } else if (classification === 'polar_night') {
      copy = 'Polar night: sun does not rise on this date.';
    } else {
      // no_civil_twilight
      copy = 'No civil twilight on this date.';
    }
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-brand/20 bg-brand/5 px-3 py-2 text-sm"
        aria-label={`${name}: ${copy}`}
      >
        <Sun className="h-4 w-4 text-brand shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <span className="font-mono text-brand-ink">{name}</span>
          <p className="text-brand-ink/80 text-xs mt-0.5">{copy}</p>
        </div>
      </div>
    );
  }

  // Normal classification
  if (wouldViolate && events) {
    // Determine which boundary was actually crossed.
    //
    // When the caller supplies candidateStartMs/candidateEndMs, compare the
    // candidate window against the boundary times directly.  Fall back to
    // boundary-existence only when the candidate times are not available.
    const hasTimes =
      candidateStartMs !== undefined && candidateEndMs !== undefined;

    const endCrossesDusk =
      events.civilDuskUtcMs !== null &&
      (hasTimes ? candidateEndMs! > events.civilDuskUtcMs : true);

    const startCrossesDawn =
      events.civilDawnUtcMs !== null &&
      (hasTimes ? candidateStartMs! < events.civilDawnUtcMs : true);

    const lines: string[] = [];
    if (endCrossesDusk) {
      lines.push(`Ends after civil dusk (${epochToLocal(events.civilDuskUtcMs!)})`);
    }
    if (startCrossesDawn) {
      lines.push(`Starts before civil dawn (${epochToLocal(events.civilDawnUtcMs!)})`);
    }
    if (lines.length === 0) {
      lines.push('Crosses civil twilight boundary');
    }

    return (
      <div
        className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm"
        role="status"
        aria-label={`${name}: ${lines.join('; ')}`}
      >
        <Moon className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <span className="font-mono text-amber-900 dark:text-amber-200">{name}</span>
          {lines.map((line, i) => (
            <p key={i} className="text-amber-800 dark:text-amber-200 text-xs mt-0.5">{line}</p>
          ))}
        </div>
      </div>
    );
  }

  // Normal, within daylight
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-3 py-2 text-sm"
      aria-label={`${name}: within daylight`}
    >
      <Sun className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" aria-hidden="true" />
      <div>
        <span className="font-mono text-green-900 dark:text-green-200">{name}</span>
        <p className="text-green-700 dark:text-green-300 text-xs mt-0.5">Within daylight</p>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TwilightIndicator({
  state,
  perResource,
  resourceNames,
  candidateStartMs,
  candidateEndMs,
}: TwilightIndicatorProps) {
  if (state === 'idle') return null;

  if (state === 'loading') {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 py-1"
        role="status"
        aria-label="Checking daylight window"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        <span>Checking daylight window…</span>
      </div>
    );
  }

  if (state === 'error') {
    // Non-fatal — silently hide the indicator on error (form still submits)
    return null;
  }

  // state === 'loaded'
  if (perResource.length === 0) return null;

  // Filter to aircraft only (instructors have no daylight relevance)
  const aircraftReports = perResource.filter((r) => resourceNames.has(r.resourceId));

  if (aircraftReports.length === 0) return null;

  return (
    <div className="space-y-1.5" aria-label="Civil-twilight day/night indicators">
      <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
        Day/night window (advisory)
        {/* [VERIFY-4a-A] astronomy, not FAA night-currency */}
      </p>
      {aircraftReports.map((r) => (
        <ResourceBadge
          key={r.resourceId}
          report={r}
          name={resourceNames.get(r.resourceId) ?? r.resourceId}
          candidateStartMs={candidateStartMs}
          candidateEndMs={candidateEndMs}
        />
      ))}
    </div>
  );
}
