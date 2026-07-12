/**
 * member-logbook-card.tsx — Logbook facet on the People member-detail page
 * (Slice P2).
 *
 * Renders this member's derived pilot logbook (closed dispatch history) with
 * a Download CSV action. Shows for people:access holders — the card itself
 * fails closed (renders empty, never crashes) if the read is refused.
 *
 * COMPLIANCE HARD LINE: a CONVENIENCE VIEW of this member's dispatch history
 * — NOT their official/certified §61.51 logbook of record. Makes NO
 * currency/experience/§61.51/§61.57 determination. Verbatim disclaimer below.
 */
import * as React from 'react';
import { BookOpen } from 'lucide-react';
import { getPilotLogAction, exportPilotLogCsvAction } from '../actions';
import { DownloadCsvButton } from './download-csv-button';
// Shared with the portal logbook page — the underlying annotateFlightAction
// enforces self-vs-staff scoping server-side (people:access holders may
// annotate any in-org pilot's closed flight).
import { AnnotateFlightDialog } from '../../portal/logbook/_components/annotate-flight-dialog';

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

interface MemberLogbookCardProps {
  userId: string;
}

export async function MemberLogbookCard({ userId }: MemberLogbookCardProps) {
  // Fail-closed: if people:access is somehow refused, render an empty card
  // rather than crash the page (the page itself already requires people:access).
  let entries: Array<{
    ticketId: string;
    date: string;
    tail: string;
    make: string | null;
    model: string | null;
    category: string | null;
    aircraftClass: string | null;
    hobbsOut: number;
    hobbsIn: number;
    flightTimeHours: number;
    runningTotalHours: number;
    nightHours: number | null;
    instrumentHours: number | null;
    crossCountryHours: number | null;
    remarks: string | null;
  }> = [];
  let totalHours = 0;
  let notFound = false;

  try {
    const result = await getPilotLogAction(userId);
    if (result && 'ok' in result) {
      if (result.ok) {
        entries = result.log.entries;
        totalHours = result.log.totalHours;
      } else {
        notFound = true;
      }
    }
  } catch {
    // fail-closed
  }

  if (notFound) return null;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-700">Logbook</h2>
          <span className="nums text-xs text-slate-400">({entries.length})</span>
        </div>
        <DownloadCsvButton action={() => exportPilotLogCsvAction(userId)} />
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No logged flights for this member.</p>
      ) : (
        <div className="rounded-md border border-slate-100 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm" aria-label="Member logbook">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500">Date</th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500">Tail</th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 hidden sm:table-cell">Cat / Class</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 hidden sm:table-cell">Hobbs Out / In</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">Flight Time</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">Night</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">Instrument</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">XC</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">Running Total</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.ticketId} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 text-xs text-slate-600 nums">{formatDate(e.date)}</td>
                  <td className="px-3 py-2 text-sm font-medium text-slate-800">{e.tail}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 hidden sm:table-cell whitespace-nowrap">
                    {e.category || e.aircraftClass
                      ? [e.category, e.aircraftClass].filter(Boolean).join(' / ')
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right hidden sm:table-cell">
                    <span className="nums text-xs text-slate-700">
                      {e.hobbsOut.toFixed(1)} / {e.hobbsIn.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="nums text-xs text-slate-700">{e.flightTimeHours.toFixed(1)} h</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="nums text-xs text-slate-700">
                      {e.nightHours != null ? `${e.nightHours.toFixed(1)} h` : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="nums text-xs text-slate-700">
                      {e.instrumentHours != null ? `${e.instrumentHours.toFixed(1)} h` : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="nums text-xs text-slate-700">
                      {e.crossCountryHours != null ? `${e.crossCountryHours.toFixed(1)} h` : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="nums text-xs font-semibold text-slate-900">{e.runningTotalHours.toFixed(1)} h</span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <AnnotateFlightDialog
                      ticketId={e.ticketId}
                      tail={e.tail}
                      nightHours={e.nightHours}
                      instrumentHours={e.instrumentHours}
                      crossCountryHours={e.crossCountryHours}
                      remarks={e.remarks}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50">
                <td colSpan={8} className="px-3 py-2 text-right text-xs font-semibold text-slate-600">Total</td>
                <td className="px-3 py-2 text-right">
                  <span className="nums text-sm font-bold text-slate-900">{totalHours.toFixed(1)} h</span>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Verbatim disclaimer — always rendered, not gated behind the empty state. */}
      <p className="text-[0.6875rem] text-slate-400">
        This logbook is a convenience view generated from this member&rsquo;s dispatch
        records. It is not their official pilot logbook and is not a certified
        record under 14 CFR 61.51. AeroOps makes no determination of flight
        experience, currency, or recency under 14 CFR 61.51 or 61.57. Night,
        instrument, cross-country, remarks, and aircraft category/class are
        operator/pilot-entered data — not an FAA logbook of record; AeroOps does
        not compute currency.
      </p>
    </div>
  );
}
