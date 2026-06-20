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
}

// ─── sub-components ───────────────────────────────────────────────────────────

function ResourceBadge({ report, name }: { report: PreviewTwilightResourceReport; name: string }) {
  const { events, wouldViolate, classification } = report;

  // No coords / no home base → muted info hint
  if (!events && classification === null) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
        aria-label={`${name}: daylight unknown`}
      >
        <HelpCircle className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <span className="font-mono text-slate-700">{name}</span>
          <p className="text-slate-500 text-xs mt-0.5">
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
    // Determine which boundary was violated and show the time
    const endCrossesDusk =
      events.civilDuskUtcMs !== null;
    const startCrossesDawn =
      events.civilDawnUtcMs !== null;

    // Prefer dusk violation (ends after civil dusk) since that's most common for
    // evening flights; if both would fire show both (unlikely but possible).
    const lines: string[] = [];
    if (endCrossesDusk && events.civilDuskUtcMs !== null) {
      lines.push(`Ends after civil dusk (${epochToLocal(events.civilDuskUtcMs)})`);
    }
    if (startCrossesDawn && events.civilDawnUtcMs !== null) {
      lines.push(`Starts before civil dawn (${epochToLocal(events.civilDawnUtcMs)})`);
    }
    if (lines.length === 0) {
      lines.push('Crosses civil twilight boundary');
    }

    return (
      <div
        className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm"
        role="status"
        aria-label={`${name}: ${lines.join('; ')}`}
      >
        <Moon className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <span className="font-mono text-amber-900">{name}</span>
          {lines.map((line, i) => (
            <p key={i} className="text-amber-800 text-xs mt-0.5">{line}</p>
          ))}
        </div>
      </div>
    );
  }

  // Normal, within daylight
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm"
      aria-label={`${name}: within daylight`}
    >
      <Sun className="h-4 w-4 text-green-600 shrink-0 mt-0.5" aria-hidden="true" />
      <div>
        <span className="font-mono text-green-900">{name}</span>
        <p className="text-green-700 text-xs mt-0.5">Within daylight</p>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TwilightIndicator({
  state,
  perResource,
  resourceNames,
}: TwilightIndicatorProps) {
  if (state === 'idle') return null;

  if (state === 'loading') {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-500 py-1"
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
      <p className="text-xs text-slate-500 font-medium">
        Day/night window (advisory)
        {/* [VERIFY-4a-A] astronomy, not FAA night-currency */}
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
