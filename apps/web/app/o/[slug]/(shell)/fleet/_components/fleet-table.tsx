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
import { StatusBadge } from '@/components/ui/status-badge';

interface FleetTableProps {
  aircraft: AircraftListRow[];
  slug: string;
}

// ─── Status chip helpers (design-system StatusBadge) ─────────────────────────

function GroundedChip() {
  return (
    <StatusBadge variant="danger" aria-label="Grounded">
      <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
      Grounded
    </StatusBadge>
  );
}

function ActiveChip() {
  return <StatusBadge variant="success">Active</StatusBadge>;
}

function InactiveChip() {
  return <StatusBadge variant="neutral">Inactive</StatusBadge>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FleetTable({ aircraft, slug }: FleetTableProps) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
      <table className="w-full text-sm" aria-label="Fleet aircraft">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide"
            >
              Tail #
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell"
            >
              Make / Model
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide"
            >
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {aircraft.map((row) => (
            <tr
              key={row.id}
              className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              {/* Tail # → links to detail page */}
              <td className="px-3 py-3">
                <Link
                  href={`/o/${slug}/fleet/${row.id}`}
                  className="font-bold nums text-slate-900 dark:text-slate-100 hover:text-brand underline-offset-2 hover:underline"
                  aria-label={`View details for ${row.tailNumber}`}
                >
                  {row.tailNumber}
                </Link>
              </td>

              {/* Make / Model */}
              <td className="px-3 py-3 hidden sm:table-cell">
                {row.make || row.model ? (
                  <span className="text-slate-700 dark:text-slate-300">
                    {[row.make, row.model].filter(Boolean).join(' ')}
                  </span>
                ) : (
                  <span className="text-slate-400 dark:text-slate-500 italic text-xs">—</span>
                )}
              </td>

              {/* Status chips */}
              <td className="px-3 py-3">
                <div className="flex flex-wrap gap-1.5 items-center">
                  {row.grounded && <GroundedChip />}
                  {row.openSquawkCount > 0 && (
                    <Link
                      href={`/o/${slug}/maintenance/squawks?resourceId=${row.id}`}
                      className="inline-flex items-center gap-1 rounded-sm border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
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
