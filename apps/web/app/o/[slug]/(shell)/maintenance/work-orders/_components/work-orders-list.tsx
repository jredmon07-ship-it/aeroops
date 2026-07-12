/**
 * work-orders-list.tsx — Client component for the work-orders list + filters.
 *
 * States: loading / empty / populated / error (handled at page level).
 * Filters: by aircraft (select) + by status (select).
 * Primary action: Open work order (gated maintenance:work_order).
 *
 * Design: matches squawk-list.tsx tight-corner primitives + design tokens.
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Wrench, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkOrderStatusBadge } from './work-order-status-badge';
import { OpenWorkOrderDialog } from './open-work-order-dialog';
import { formatDate } from './work-order-utils';
import type { SerializedWorkOrderView } from '../actions';
import type { AircraftListRow } from '@aeroops/api';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Props ────────────────────────────────────────────────────────────────────

interface WorkOrdersListProps {
  initialWorkOrders: SerializedWorkOrderView[];
  aircraft: AircraftListRow[];
  slug: string;
  canWorkOrder: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function WorkOrdersList({
  initialWorkOrders,
  aircraft,
  slug,
  canWorkOrder,
}: WorkOrdersListProps) {
  const [workOrders, setWorkOrders] =
    React.useState<SerializedWorkOrderView[]>(initialWorkOrders);

  // Filters
  const [filterResourceId, setFilterResourceId] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState('');

  // Open dialog
  const [openDialogOpen, setOpenDialogOpen] = React.useState(false);

  // Filtered work orders
  const filtered = React.useMemo(() => {
    return workOrders.filter((wo) => {
      if (filterResourceId && wo.resourceId !== filterResourceId) return false;
      if (filterStatus && wo.status !== filterStatus) return false;
      return true;
    });
  }, [workOrders, filterResourceId, filterStatus]);

  function handleOpenSuccess(newWo: SerializedWorkOrderView) {
    setWorkOrders((prev) => [newWo, ...prev]);
  }

  function aircraftName(resourceId: string): string {
    const a = aircraft.find((r) => r.id === resourceId);
    return a?.tailNumber ?? resourceId;
  }

  return (
    <div className="space-y-4">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <PageHeader
        title="Work Orders"
        actions={
          canWorkOrder && (
            <Button onClick={() => setOpenDialogOpen(true)}>
              + Open work order
            </Button>
          )
        }
      />

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <label htmlFor="wo-filter-aircraft" className="text-xs text-slate-500 font-medium">
            Aircraft
          </label>
          <select
            id="wo-filter-aircraft"
            value={filterResourceId}
            onChange={(e) => setFilterResourceId(e.target.value)}
            className="flex h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 transition-colors"
          >
            <option value="">All aircraft</option>
            {aircraft.map((a) => (
              <option key={a.id} value={a.id}>
                {a.tailNumber}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="wo-filter-status" className="text-xs text-slate-500 font-medium">
            Status
          </label>
          <select
            id="wo-filter-status"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="flex h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 transition-colors"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {filtered.length === 0 && (
        <EmptyState
          icon={Wrench}
          title={
            workOrders.length === 0
              ? 'No work orders yet.'
              : 'No work orders match your filters.'
          }
          cta={
            canWorkOrder && workOrders.length === 0 && (
              <Button variant="outline" onClick={() => setOpenDialogOpen(true)}>
                Open first work order
              </Button>
            )
          }
        />
      )}

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      {filtered.length > 0 && (
        <div className="rounded-md border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Work orders">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide"
                >
                  Aircraft
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide"
                >
                  Title
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell"
                >
                  Linked squawk
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell"
                >
                  Opened
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((wo) => (
                <tr
                  key={wo.id}
                  className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
                >
                  <td className="px-3 py-3">
                    <span className="font-mono text-xs nums text-slate-700">
                      {aircraftName(wo.resourceId)}
                    </span>
                  </td>
                  <td className="px-3 py-3 max-w-xs">
                    <Link
                      href={`/o/${slug}/maintenance/work-orders/${wo.id}`}
                      className="font-medium text-slate-900 hover:text-brand hover:underline underline-offset-2 truncate block"
                    >
                      {wo.title}
                    </Link>
                    {wo.description && (
                      <p className="text-xs text-slate-500 truncate">{wo.description}</p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <WorkOrderStatusBadge status={wo.status} />
                  </td>
                  <td className="px-3 py-3 hidden sm:table-cell">
                    {wo.squawkId ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-amber-700"
                        title="Has linked squawk"
                      >
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                        Linked
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500 nums hidden sm:table-cell">
                    {formatDate(wo.openedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Open Work Order dialog ─────────────────────────────────────────── */}
      <OpenWorkOrderDialog
        open={openDialogOpen}
        onOpenChange={setOpenDialogOpen}
        aircraft={aircraft}
        onSuccess={handleOpenSuccess}
      />
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

export function WorkOrdersListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading work orders">
      <div className="flex items-center justify-between gap-4">
        <div className="h-8 bg-slate-200 rounded w-40" />
        <div className="h-10 bg-slate-200 rounded w-44" />
      </div>
      <div className="flex gap-3">
        <div className="h-9 bg-slate-200 rounded w-40" />
        <div className="h-9 bg-slate-200 rounded w-32" />
      </div>
      <div className="rounded-md border border-slate-200 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}
