/**
 * maintenance-due-list.tsx — Client component for the maintenance-due list +
 * filters + CRUD actions (Slice P1.5).
 *
 * States: loading / empty / populated / error (handled at page level).
 * Filters: aircraft (select) + status bucket (select).
 * Row actions: Mark serviced / Edit / Deactivate (gated on canManage).
 *
 * COMPLIANCE banner (verbatim): operator-entered tracking + arithmetic
 * reminders — NOT a computed Part-43/91.409 airworthiness or inspection-due
 * determination. A mechanic/IA makes the airworthiness call.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { AlertTriangle, Clock, CheckCircle, HelpCircle, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { MaintenanceItemDialog } from './maintenance-item-dialog';
import { MarkServicedDialog } from './mark-serviced-dialog';
import { deactivateMaintenanceItemAction, notifyMaintenanceDueAction } from '../../due-actions';
import type { SerializedMaintenanceDueView, SerializedMaintenanceItemView } from '../../due-actions';
import type { ResourceRow } from '@aeroops/api';
import type { MaintenanceDueStatus } from '@aeroops/core';

// ─── Props ────────────────────────────────────────────────────────────────────

interface MaintenanceDueListProps {
  initialItems: SerializedMaintenanceDueView[];
  aircraft: ResourceRow[];
  canManage: boolean;
  /** When set, this list is scoped to one aircraft (fleet-detail facet reuse). */
  fixedResourceId?: string;
}

// ─── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: MaintenanceDueStatus }) {
  const map: Record<MaintenanceDueStatus, { label: string; cls: string; icon: React.ReactNode }> = {
    overdue: {
      label: 'Overdue',
      cls: 'border-destructive/30 bg-destructive/10 text-destructive',
      icon: <AlertTriangle className="h-3 w-3" aria-hidden="true" />,
    },
    due_soon: {
      label: 'Due soon',
      cls: 'border-amber-200 bg-amber-50 text-amber-800',
      icon: <Clock className="h-3 w-3" aria-hidden="true" />,
    },
    ok: {
      label: 'OK',
      cls: 'border-green-200 bg-green-50 text-green-800',
      icon: <CheckCircle className="h-3 w-3" aria-hidden="true" />,
    },
    unknown: {
      label: 'No meter recorded yet',
      cls: 'border-slate-200 bg-slate-50 text-slate-500',
      icon: <HelpCircle className="h-3 w-3" aria-hidden="true" />,
    },
  };
  const { label, cls, icon } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${cls}`}>
      {icon}
      {label}
    </span>
  );
}

function formatRemaining(item: SerializedMaintenanceDueView): string | null {
  if (item.trackBy === 'hours' && item.remainingHours !== undefined) {
    const v = item.remainingHours;
    return v <= 0 ? `${Math.abs(v).toFixed(1)} hrs past` : `${v.toFixed(1)} hrs remaining`;
  }
  if (item.trackBy === 'date' && item.remainingDays !== undefined) {
    const v = item.remainingDays;
    return v <= 0 ? `${Math.abs(v)} days past` : `${v} days remaining`;
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MaintenanceDueList({
  initialItems,
  aircraft,
  canManage,
  fixedResourceId,
}: MaintenanceDueListProps) {
  const [items, setItems] = React.useState<SerializedMaintenanceDueView[]>(initialItems);

  const [filterResourceId, setFilterResourceId] = React.useState(fixedResourceId ?? '');
  const [filterStatus, setFilterStatus] = React.useState<'' | MaintenanceDueStatus>('');

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [serviceTarget, setServiceTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [deactivateTarget, setDeactivateTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [isDeactivating, setIsDeactivating] = React.useState(false);
  const [deactivateError, setDeactivateError] = React.useState<string | null>(null);

  const [notifyState, setNotifyState] = React.useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [notifyMessage, setNotifyMessage] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    return items.filter((i) => {
      if (filterResourceId && i.resourceId !== filterResourceId) return false;
      if (filterStatus && i.status !== filterStatus) return false;
      return true;
    });
  }, [items, filterResourceId, filterStatus]);

  function aircraftName(resourceId: string): string {
    const r = aircraft.find((a) => a.id === resourceId);
    return r?.tailNumber ?? r?.displayName ?? resourceId;
  }

  function handleCreateSuccess(created: SerializedMaintenanceItemView) {
    // The dialog returns a MaintenanceItemView (no status yet) — re-fetch is
    // heavier than needed; append with a conservative 'unknown' status so the
    // row appears immediately and is corrected on next natural reload.
    setItems((prev) => [
      {
        ...created,
        status: 'unknown',
        currentHobbs: null,
        currentTach: null,
      },
      ...prev,
    ]);
  }

  function handleEditSuccess(updated: SerializedMaintenanceItemView) {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)));
  }

  function handleServiceSuccess(updated: SerializedMaintenanceDueView) {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? { ...i, ...updated, status: 'ok' } : i)));
  }

  async function handleDeactivateConfirm() {
    if (!deactivateTarget) return;
    setIsDeactivating(true);
    setDeactivateError(null);
    try {
      const result = await deactivateMaintenanceItemAction({ itemId: deactivateTarget.id });
      if ('error' in result) {
        setDeactivateError('Could not deactivate this item. Please try again.');
        return;
      }
      if (!result.ok) {
        setDeactivateError('That item could not be found.');
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== deactivateTarget.id));
      setDeactivateTarget(null);
    } catch {
      setDeactivateError('Could not deactivate this item. Please try again.');
    } finally {
      setIsDeactivating(false);
    }
  }

  async function handleNotify() {
    setNotifyState('sending');
    setNotifyMessage(null);
    try {
      const result = await notifyMaintenanceDueAction(fixedResourceId ? { resourceId: fixedResourceId } : {});
      if ('error' in result) {
        setNotifyState('error');
        setNotifyMessage('Could not send the notification. Please try again.');
        return;
      }
      const r = result.result;
      setNotifyState('done');
      if (r.overdueCount === 0 && r.dueSoonCount === 0) {
        setNotifyMessage('Nothing is due — no notification sent.');
      } else {
        setNotifyMessage(
          `Sent to ${r.sentCount} of ${r.recipientCount} owner/manager recipient(s) (${r.overdueCount} overdue, ${r.dueSoonCount} due soon).`,
        );
      }
    } catch {
      setNotifyState('error');
      setNotifyMessage('Could not send the notification. Please try again.');
    }
  }

  const overdueCount = items.filter((i) => i.status === 'overdue').length;
  const dueSoonCount = items.filter((i) => i.status === 'due_soon').length;

  return (
    <div className="space-y-4">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tightish text-slate-900">Maintenance due</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {overdueCount} overdue · {dueSoonCount} due soon
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button variant="outline" size="sm" onClick={handleNotify} disabled={notifyState === 'sending'}>
              <Mail className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              {notifyState === 'sending' ? 'Sending…' : 'Notify owners/managers'}
            </Button>
          )}
          {canManage && <Button onClick={() => setCreateOpen(true)}>+ Add item</Button>}
        </div>
      </div>

      {notifyMessage && (
        <p
          role="status"
          aria-live="polite"
          className={`text-xs ${notifyState === 'error' ? 'text-destructive' : 'text-slate-600'}`}
        >
          {notifyMessage}
        </p>
      )}

      {/* ── Compliance banner ────────────────────────────────────────────── */}
      <p className="text-xs text-slate-500 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
        Operator-entered tracking data and arithmetic reminders — not a computed Part-43/91.409
        airworthiness or inspection-due determination. A mechanic/IA makes the airworthiness call.
      </p>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      {!fixedResourceId && (
        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <label htmlFor="mi-filter-aircraft" className="text-xs text-slate-500 font-medium">
              Aircraft
            </label>
            <select
              id="mi-filter-aircraft"
              value={filterResourceId}
              onChange={(e) => setFilterResourceId(e.target.value)}
              className="flex h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 transition-colors"
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
            <label htmlFor="mi-filter-status" className="text-xs text-slate-500 font-medium">
              Status
            </label>
            <select
              id="mi-filter-status"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as '' | MaintenanceDueStatus)}
              className="flex h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 transition-colors"
            >
              <option value="">All statuses</option>
              <option value="overdue">Overdue</option>
              <option value="due_soon">Due soon</option>
              <option value="ok">OK</option>
              <option value="unknown">No meter recorded yet</option>
            </select>
          </div>
        </div>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center space-y-3" role="status">
          <CheckCircle className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-slate-500 font-medium">
            {items.length === 0 ? 'No maintenance items tracked yet.' : 'No items match your filters.'}
          </p>
          {canManage && items.length === 0 && (
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              Add first item
            </Button>
          )}
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      {filtered.length > 0 && (
        <div className="rounded-md border border-slate-200 overflow-hidden">
          <table className="w-full text-sm" aria-label="Maintenance due items">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {!fixedResourceId && (
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Aircraft
                  </th>
                )}
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Item
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
                  Due
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide sr-only">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
                  {!fixedResourceId && (
                    <td className="px-3 py-3">
                      <span className="font-mono text-xs nums text-slate-700">{aircraftName(item.resourceId)}</span>
                    </td>
                  )}
                  <td className="px-3 py-3 max-w-xs">
                    <p className="font-medium text-slate-900 truncate">{item.title}</p>
                    {item.notes && <p className="text-xs text-slate-500 truncate">{item.notes}</p>}
                  </td>
                  <td className="px-3 py-3">
                    <StatusChip status={item.status} />
                  </td>
                  <td className="px-3 py-3 hidden sm:table-cell">
                    <span className="text-xs text-slate-500">
                      {item.trackBy === 'hours'
                        ? `${item.dueValueHours ?? '—'} ${item.meterBasis ?? ''} hrs`
                        : item.dueDate ?? '—'}
                      {formatRemaining(item) ? ` (${formatRemaining(item)})` : ''}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {canManage && (
                      <div className="flex gap-1.5 justify-end">
                        <Button variant="outline" size="sm" onClick={() => setServiceTarget(item)}>
                          Mark serviced
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditTarget(item)}>
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeactivateTarget(item)}
                        >
                          Deactivate
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create dialog ─────────────────────────────────────────────────── */}
      <MaintenanceItemDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode="create"
        aircraft={aircraft}
        preselectResourceId={fixedResourceId}
        onSuccess={handleCreateSuccess}
      />

      {/* ── Edit dialog ───────────────────────────────────────────────────── */}
      {editTarget && (
        <MaintenanceItemDialog
          open={!!editTarget}
          onOpenChange={(o) => !o && setEditTarget(null)}
          mode="edit"
          aircraft={aircraft}
          item={editTarget}
          onSuccess={(updated) => {
            handleEditSuccess(updated);
            setEditTarget(null);
          }}
        />
      )}

      {/* ── Mark-serviced dialog ─────────────────────────────────────────── */}
      {serviceTarget && (
        <MarkServicedDialog
          open={!!serviceTarget}
          onOpenChange={(o) => !o && setServiceTarget(null)}
          item={serviceTarget}
          onSuccess={(updated) => {
            handleServiceSuccess(updated);
            setServiceTarget(null);
          }}
        />
      )}

      {/* ── Deactivate confirm ───────────────────────────────────────────── */}
      <AlertDialog open={!!deactivateTarget} onOpenChange={(o) => !o && setDeactivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate &ldquo;{deactivateTarget?.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops tracking the item. It will no longer appear in due-status lists. This can
              be undone by adding it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deactivateError && (
            <p role="alert" className="text-xs text-destructive">
              {deactivateError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeactivating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDeactivateConfirm();
              }}
              disabled={isDeactivating}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isDeactivating ? 'Deactivating…' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Loading skeleton (exported for Suspense) ─────────────────────────────────

export function MaintenanceDueListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading maintenance due items">
      <div className="flex items-center justify-between gap-4">
        <div className="h-8 bg-slate-200 rounded w-48" />
        <div className="h-10 bg-slate-200 rounded w-32" />
      </div>
      <div className="rounded-md border border-slate-200 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}
