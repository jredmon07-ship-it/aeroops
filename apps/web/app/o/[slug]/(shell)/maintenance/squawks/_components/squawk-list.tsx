/**
 * squawk-list.tsx — Client component for the squawk list + filter + actions.
 *
 * States: loading / empty / populated / error (handled at page level).
 * Filters: by aircraft (select) + by status (select).
 * Row actions: Resolve / Defer for open squawks (maintenance:squawk).
 *
 * Design: matches dispatch board tight-corner primitives + design tokens.
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { CheckCircle, Clock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ResolveSquawkDialog } from './resolve-squawk-dialog';
import { ReportSquawkDialog } from './report-squawk-dialog';
import type { SquawkView, ResourceRow } from '@aeroops/api';
import type { SquawkSeverity, SquawkStatus } from '@aeroops/core';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SquawkListProps {
  initialSquawks: SquawkView[];
  aircraft: ResourceRow[];
  canSquawk: boolean;
  canGround: boolean;
}

// ─── Chip helpers ─────────────────────────────────────────────────────────────

function SeverityChip({ severity }: { severity: SquawkSeverity }) {
  const map: Record<SquawkSeverity, { label: string; cls: string }> = {
    low: { label: 'Low', cls: 'border-slate-200 bg-slate-50 text-slate-600' },
    medium: { label: 'Medium', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
    high: { label: 'High', cls: 'border-orange-200 bg-orange-50 text-orange-800' },
    grounding: { label: 'Grounding', cls: 'border-destructive/30 bg-destructive/10 text-destructive' },
  };
  const { label, cls } = map[severity];
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${cls}`}
    >
      {label}
    </span>
  );
}

function StatusChip({ status }: { status: SquawkStatus }) {
  const map: Record<SquawkStatus, { label: string; cls: string; icon: React.ReactNode }> = {
    open: {
      label: 'Open',
      cls: 'border-sky-200 bg-sky-50 text-sky-800',
      icon: <AlertTriangle className="h-3 w-3" aria-hidden="true" />,
    },
    deferred: {
      label: 'Deferred',
      cls: 'border-amber-200 bg-amber-50 text-amber-800',
      icon: <Clock className="h-3 w-3" aria-hidden="true" />,
    },
    resolved: {
      label: 'Resolved',
      cls: 'border-green-200 bg-green-50 text-green-800',
      icon: <CheckCircle className="h-3 w-3" aria-hidden="true" />,
    },
  };
  const { label, cls, icon } = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${cls}`}
    >
      {icon}
      {label}
    </span>
  );
}

function formatDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SquawkList({
  initialSquawks,
  aircraft,
  canSquawk,
  canGround,
}: SquawkListProps) {
  const [squawks, setSquawks] = React.useState<SquawkView[]>(initialSquawks);

  // Filters
  const [filterResourceId, setFilterResourceId] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<'' | SquawkStatus>('');

  // Resolve/defer dialog
  const [resolveOpen, setResolveOpen] = React.useState(false);
  const [resolveMode, setResolveMode] = React.useState<'resolved' | 'deferred'>('resolved');
  const [resolveTarget, setResolveTarget] = React.useState<SquawkView | null>(null);

  // Report squawk dialog
  const [reportOpen, setReportOpen] = React.useState(false);

  // Filtered squawks
  const filtered = React.useMemo(() => {
    return squawks.filter((s) => {
      if (filterResourceId && s.resourceId !== filterResourceId) return false;
      if (filterStatus && s.status !== filterStatus) return false;
      return true;
    });
  }, [squawks, filterResourceId, filterStatus]);

  function handleOpenResolve(squawk: SquawkView, mode: 'resolved' | 'deferred') {
    setResolveTarget(squawk);
    setResolveMode(mode);
    setResolveOpen(true);
  }

  function handleResolveSuccess(updated: SquawkView) {
    setSquawks((prev) =>
      prev.map((s) => (s.id === updated.id ? updated : s)),
    );
  }

  function handleReportSuccess(squawk: SquawkView) {
    setSquawks((prev) => [squawk, ...prev]);
  }

  function aircraftName(resourceId: string): string {
    const r = aircraft.find((a) => a.id === resourceId);
    return r?.tailNumber ?? r?.displayName ?? resourceId;
  }

  return (
    <div className="space-y-4">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Squawks</h1>
        {canSquawk && (
          <Button onClick={() => setReportOpen(true)}>
            + Report squawk
          </Button>
        )}
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <label htmlFor="filter-aircraft" className="text-xs text-slate-500 font-medium">
            Aircraft
          </label>
          <select
            id="filter-aircraft"
            value={filterResourceId}
            onChange={(e) => setFilterResourceId(e.target.value)}
            className="flex h-9 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2"
          >
            <option value="">All aircraft</option>
            {aircraft.map((r) => (
              <option key={r.id} value={r.id}>
                {r.tailNumber ?? r.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="filter-status" className="text-xs text-slate-500 font-medium">
            Status
          </label>
          <select
            id="filter-status"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as '' | SquawkStatus)}
            className="flex h-9 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="deferred">Deferred</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {filtered.length === 0 && (
        <div
          className="flex flex-col items-center justify-center py-16 text-center space-y-3"
          role="status"
        >
          <CheckCircle className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-slate-500 font-medium">
            {squawks.length === 0
              ? 'No squawks reported yet.'
              : 'No squawks match your filters.'}
          </p>
          {canSquawk && squawks.length === 0 && (
            <Button variant="outline" onClick={() => setReportOpen(true)}>
              Report first squawk
            </Button>
          )}
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      {filtered.length > 0 && (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-sm" aria-label="Squawks">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Aircraft
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Title
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Severity
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
                  Reported
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide sr-only">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((squawk) => (
                <tr
                  key={squawk.id}
                  className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
                >
                  <td className="px-3 py-3">
                    <span className="font-mono text-xs nums text-slate-700">
                      {aircraftName(squawk.resourceId)}
                    </span>
                  </td>
                  <td className="px-3 py-3 max-w-xs">
                    <p className="font-medium text-slate-900 truncate">{squawk.title}</p>
                    {squawk.description && (
                      <p className="text-xs text-slate-500 truncate">{squawk.description}</p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <SeverityChip severity={squawk.severity} />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-1">
                      <StatusChip status={squawk.status} />
                      {squawk.resolutionNotes && (
                        <span
                          className="text-xs text-slate-500 truncate max-w-[12rem]"
                          title={squawk.resolutionNotes}
                        >
                          {squawk.resolutionNotes}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 hidden sm:table-cell">
                    <time
                      dateTime={squawk.reportedAt instanceof Date ? squawk.reportedAt.toISOString() : String(squawk.reportedAt)}
                      className="text-xs text-slate-500"
                    >
                      {formatDate(squawk.reportedAt instanceof Date ? squawk.reportedAt : new Date(squawk.reportedAt))}
                    </time>
                  </td>
                  <td className="px-3 py-3">
                    {squawk.status === 'open' && canSquawk && (
                      <div className="flex gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenResolve(squawk, 'resolved')}
                          aria-label={`Resolve squawk: ${squawk.title}`}
                        >
                          Resolve
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenResolve(squawk, 'deferred')}
                          aria-label={`Defer squawk: ${squawk.title}`}
                        >
                          Defer
                        </Button>
                      </div>
                    )}
                    {squawk.status !== 'open' && (
                      <span className="text-xs text-slate-400 italic">
                        {squawk.status === 'resolved' ? 'Resolved' : 'Deferred'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Resolve/Defer dialog ──────────────────────────────────────────── */}
      {resolveTarget && (
        <ResolveSquawkDialog
          open={resolveOpen}
          onOpenChange={setResolveOpen}
          squawk={resolveTarget}
          mode={resolveMode}
          onSuccess={handleResolveSuccess}
        />
      )}

      {/* ── Report squawk dialog ──────────────────────────────────────────── */}
      <ReportSquawkDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        aircraft={aircraft}
        canGround={canGround}
        onSuccess={handleReportSuccess}
      />
    </div>
  );
}

// ─── Loading skeleton (exported for Suspense) ─────────────────────────────────

export function SquawkListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading squawks">
      <div className="flex items-center justify-between gap-4">
        <div className="h-8 bg-slate-200 rounded w-32" />
        <div className="h-10 bg-slate-200 rounded w-36" />
      </div>
      <div className="flex gap-3">
        <div className="h-9 bg-slate-200 rounded w-40" />
        <div className="h-9 bg-slate-200 rounded w-32" />
      </div>
      <div className="rounded-lg border border-slate-200 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}
