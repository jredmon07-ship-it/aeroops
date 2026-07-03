/**
 * weather-chip.tsx — Advisory current-METAR chip for the new-reservation
 * aircraft picker (Slice W1, weather).
 *
 * Shows the selected aircraft's home-base current weather:
 *   • flight category (VFR/MVFR/IFR/LIFR) color-coded chip + wind/vis summary
 *     + "as of HH:MM" observation time + the raw METAR text on expand/hover.
 *   • no home-base ICAO / fetch failed / not yet loaded → a muted empty hint
 *     (NEVER an error banner — a weather outage never blocks booking).
 *   • flightCategory 'UNKNOWN' → shown as a muted "Unknown" chip (still
 *     surfaces wind/vis/raw text when present).
 *
 * This chip is ADVISORY / INFORMATIONAL ONLY — it never blocks the form and
 * is NOT a go/no-go, airworthiness, or dispatch determination. The pilot in
 * command makes that call, always. [VERIFY-W1-A] See
 * docs/specs/slice-weather-metar.md.
 *
 * BOUNDARY: imports only from @aeroops/api, not @aeroops/db.
 */
'use client';

import * as React from 'react';
import { CloudSun, Wind, HelpCircle, Loader2, ChevronDown } from 'lucide-react';
import type { ParsedMetar, FlightCategory } from '@aeroops/api';

export type WeatherChipState = 'idle' | 'loading' | 'loaded' | 'error';

interface WeatherChipProps {
  state: WeatherChipState;
  /** null = no home-base ICAO configured, or the provider could not resolve current weather. */
  weather: ParsedMetar | null;
  /** Display name for the aria-label (tail number or display name). */
  aircraftName: string;
}

const CATEGORY_STYLES: Record<
  Exclude<FlightCategory, 'UNKNOWN'>,
  { chipClass: string; label: string }
> = {
  VFR: { chipClass: 'border-green-200 bg-green-50 text-green-900', label: 'VFR' },
  MVFR: { chipClass: 'border-blue-200 bg-blue-50 text-blue-900', label: 'MVFR' },
  IFR: { chipClass: 'border-amber-200 bg-amber-50 text-amber-900', label: 'IFR' },
  LIFR: { chipClass: 'border-red-200 bg-red-50 text-red-900', label: 'LIFR' },
};

/** Format epoch ms to a local HH:MM string; falls back to an em-dash on failure. */
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

function formatVisibility(sm: number | null): string | null {
  if (sm === null) return null;
  return Number.isInteger(sm) ? `${sm}SM` : `${sm.toFixed(1)}SM`;
}

export function WeatherChip({ state, weather, aircraftName }: WeatherChipProps) {
  const [expanded, setExpanded] = React.useState(false);

  if (state === 'idle') return null;

  if (state === 'loading') {
    return (
      <div
        className="flex items-center gap-2 text-xs text-slate-500 py-1"
        role="status"
        aria-label={`Checking current weather for ${aircraftName}`}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        <span>Checking current weather…</span>
      </div>
    );
  }

  if (state === 'error' || weather === null) {
    // Non-fatal — a muted hint, never an error banner. Weather is advisory
    // only; a missing home-base ICAO or a provider outage must never block
    // the form.
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
        aria-label={`${aircraftName}: current weather unavailable`}
      >
        <HelpCircle className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-slate-500 text-xs">
          Current weather unavailable — no home-base airport configured, or the
          weather service could not be reached.
        </p>
      </div>
    );
  }

  // state === 'loaded' && weather !== null
  const { flightCategory, windKt, gustKt, visibilitySM, observedAt, rawText } = weather;
  const style =
    flightCategory === 'UNKNOWN'
      ? { chipClass: 'border-slate-200 bg-slate-50 text-slate-700', label: 'Unknown' }
      : CATEGORY_STYLES[flightCategory];

  const windSummary =
    windKt !== null
      ? `${windKt}${gustKt !== null ? `G${gustKt}` : ''}kt`
      : null;
  const visSummary = formatVisibility(visibilitySM);
  const asOf = observedAt !== null ? epochToLocal(observedAt) : null;

  return (
    <div
      className="rounded-md border border-slate-200 bg-white text-sm"
      aria-label={`${aircraftName}: current weather ${style.label}`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <CloudSun className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
        <span
          className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${style.chipClass}`}
        >
          {style.label}
        </span>
        {(windSummary || visSummary) && (
          <span className="flex items-center gap-1 text-slate-600 text-xs">
            {windSummary && (
              <span className="inline-flex items-center gap-0.5">
                <Wind className="h-3 w-3" aria-hidden="true" />
                {windSummary}
              </span>
            )}
            {visSummary && <span>{visSummary}</span>}
          </span>
        )}
        {asOf && <span className="text-slate-400 text-xs ml-auto">as of {asOf}</span>}
        {rawText && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide raw METAR text' : 'Show raw METAR text'}
            className="text-slate-400 hover:text-slate-600 shrink-0"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {expanded && rawText && (
        <div className="border-t border-slate-100 px-3 py-1.5 font-mono text-[11px] text-slate-500 break-all">
          {rawText}
        </div>
      )}
      <p className="px-3 pb-1.5 text-[10px] text-slate-400">
        Advisory only — not a go/no-go or airworthiness determination. The
        pilot in command decides.
      </p>
    </div>
  );
}
