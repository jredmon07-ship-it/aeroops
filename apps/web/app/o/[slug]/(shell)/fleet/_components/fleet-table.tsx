/**
 * fleet-table.tsx — Client component for the fleet aircraft list table.
 *
 * States: populated (table rows) / empty (handled at page level).
 * Each row links to /fleet/[id].
 * Status chips: Grounded (danger) / "N open squawks" (link to squawks filtered) /
 *   Inactive / Active.
 *
 * Design: tight-corner table, .nums on tail #s, design tokens.
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, WrenchIcon } from 'lucide-react';
import type { AircraftListRow } from '@aeroops/api';

interface FleetTableProps {
  aircraft: AircraftListRow[];
  slug: string;
}

// ─── Status chip helpers ──────────────────────────────────────────────────────

function GroundedChip() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-destructive"
      aria-label="Grounded"
    >
      <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
      Grounded
    </span>
  );
}

function ActiveChip() {
  return (
    <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800">
      Active
    </span>
  );
}

function InactiveChip() {
  return (
    <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
      Inactive
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FleetTable({ aircraft, slug }: FleetTableProps) {
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <table className="w-full text-sm" aria-label="Fleet aircraft">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide"
            >
              Tail #
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell"
            >
              Make / Model
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide"
            >
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {aircraft.map((row) => (
            <tr
              key={row.id}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
            >
              {/* Tail # → links to detail page */}
              <td className="px-3 py-3">
                <Link
                  href={`/o/${slug}/fleet/${row.id}`}
                  className="font-bold nums text-slate-900 hover:text-brand underline-offset-2 hover:underline"
                  aria-label={`View details for ${row.tailNumber}`}
                >
                  {row.tailNumber}
                </Link>
              </td>

              {/* Make / Model */}
              <td className="px-3 py-3 hidden sm:table-cell">
                {row.make || row.model ? (
                  <span className="text-slate-700">
                    {[row.make, row.model].filter(Boolean).join(' ')}
                  </span>
                ) : (
                  <span className="text-slate-400 italic text-xs">—</span>
                )}
              </td>

              {/* Status chips */}
              <td className="px-3 py-3">
                <div className="flex flex-wrap gap-1.5 items-center">
                  {row.grounded && <GroundedChip />}
                  {row.openSquawkCount > 0 && (
                    <Link
                      href={`/o/${slug}/maintenance/squawks?resourceId=${row.id}`}
                      className="inline-flex items-center gap-1 rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-amber-800 hover:bg-amber-100 transition-colors"
                      aria-label={`${row.openSquawkCount} open squawk${row.openSquawkCount !== 1 ? 's' : ''} for ${row.tailNumber}`}
                    >
                      <WrenchIcon className="h-2.5 w-2.5" aria-hidden="true" />
                      {row.openSquawkCount} open squawk{row.openSquawkCount !== 1 ? 's' : ''}
                    </Link>
                  )}
                  {!row.active ? <InactiveChip /> : !row.grounded && row.openSquawkCount === 0 && <ActiveChip />}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
