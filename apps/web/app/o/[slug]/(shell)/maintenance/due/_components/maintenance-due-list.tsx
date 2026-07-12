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
import {
  deactivateMaintenanceItemAction,
  notifyMaintenanceDueAction,
  seedCommonRemindersAction,
} from '../../due-actions';
import type { SerializedMaintenanceDueView, SerializedMaintenanceItemView } from '../../due-actions';
import { computeMaintenanceProgress } from '@/lib/maintenance-progress';
import type { ResourceRow } from '@aeroops/api';
import type { MaintenanceDueStatus } from '@aeroops/core';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Props ────────────────────────────────────────────────────────────────────

interface MaintenanceDueListProps {
  initialItems: SerializedMaintenanceDueView[];
  aircraft: ResourceRow[];
  canManage: boolean;
  /** Owner/manager only — shows the one-click "Add common reminders" seed. */
  canSeedCommon?: boolean;
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
    <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 ${cls}`}>
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

// ─── FC-style progress bar (pct remaining vs the item's interval) ─────────────
//
// Display-only visual aid on top of the authoritative remaining hours/days —
// pure math in lib/maintenance-progress.ts (unit-tested). EXPIRED = full red
// bar with label; <=20% remaining amber; else green; unknown = no bar.

function itemProgress(item: SerializedMaintenanceDueView) {
  return computeMaintenanceProgress({
    trackBy: item.trackBy,
    title: item.title,
    remaining: item.trackBy === 'hours' ? item.remainingHours : item.remainingDays,
  });
}

function RemainingBar({ item }: { item: SerializedMaintenanceDueView }) {
  const p = itemProgress(item);
  if (p.tone === 'unknown') {
    return <span className="text-xs text-slate-400">—</span>;
  }
  const fillCls =
    p.tone === 'expired' ? 'bg-red-500' : p.tone === 'warn' ? 'bg-amber-400' : 'bg-green-500';
  const remainingText = formatRemaining(item) ?? '';
  return (
    <div className="w-32 space-y-0.5">
      <div
        role="img"
        aria-label={
          p.tone === 'expired' ? `Expired — ${remainingText}` : `${p.pctRemaining}% of interval remaining — ${remainingText}`
        }
        className="relative h-2.5 w-full overflow-hidden rounded-sm bg-slate-100 border border-slate-200"
      >
        <div className={`h-full ${fillCls}`} style={{ width: `${p.fillPct}%` }} />
        {p.tone === 'expired' && (
          <span className="absolute inset-0 grid place-items-center text-[8px] font-bold leading-none tracking-widest text-white">
            EXPIRED
          </span>
        )}
      </div>
      <p className="text-[0.6875rem] text-slate-500 nums">{remainingText}</p>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MaintenanceDueList({
  initialItems,
  aircraft,
  canManage,
  canSeedCommon = false,
  fixedResourceId,
}: MaintenanceDueListProps) {
  const [items, setItems] = React.useState<SerializedMaintenanceDueView[]>(initialItems);

  const [filterResourceId, setFilterResourceId] = React.useState(fixedResourceId ?? '');
  const [filterStatus, setFilterStatus] = React.useState<'' | MaintenanceDueStatus>('');
  const [sortBy, setSortBy] = React.useState<'status' | 'remaining'>('status');

  const [seedState, setSeedState] = React.useState<'idle' | 'seeding' | 'error'>('idle');
  const [seedError, setSeedError] = React.useState<string | null>(null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [serviceTarget, setServiceTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [deactivateTarget, setDeactivateTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [isDeactivating, setIsDeactivating] = React.useState(false);
  const [deactivateError, setDeactivateError] = React.useState<string | null>(null);

  const [notifyState, setNotifyState] = React.useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [notifyMessage, setNotifyMessage] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const list = items.filter((i) => {
      if (filterResourceId && i.resourceId !== filterResourceId) return false;
      if (filterStatus && i.status !== filterStatus) return false;
      return true;
    });
    if (sortBy === 'remaining') {
      // Most urgent first: normalized remaining fraction ascending (expired
      // sorts by how far past due; unknown last). Stable tiebreak: title.
      return [...list].sort((a, b) => {
        const d = itemProgress(a).sortKey - itemProgress(b).sortKey;
        if (d !== 0) return d;
        return a.title.localeCompare(b.title);
      });
    }
    return list; // server order: overdue → due_soon → unknown → ok
  }, [items, filterResourceId, filterStatus, sortBy]);

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

  // "Add common reminders" — owner/manager, one specific aircraft in context,
  // and that aircraft has ZERO tracked items.
  const seedTargetId = fixedResourceId ?? filterResourceId;
  const seedTargetHasNoItems =
    !!seedTargetId && !items.some((i) => i.resourceId === seedTargetId);
  const showSeedButton = canManage && canSeedCommon && seedTargetHasNoItems;

  async function handleSeedCommon() {
    if (!seedTargetId) return;
    setSeedState('seeding');
    setSeedError(null);
    try {
      const result = await seedCommonRemindersAction({ resourceId: seedTargetId });
      if ('error' in result) {
        setSeedState('error');
        setSeedError(
          result.error === 'validation' && result.message
            ? result.message
            : 'Could not add the common reminders. Please try again.',
        );
        return;
      }
      setItems((prev) => [...result.items, ...prev.filter((i) => i.resourceId !== seedTargetId)]);
      setSeedState('idle');
    } catch {
      setSeedState('error');
      setSeedError('Could not add the common reminders. Please try again.');
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <PageHeader
        title="Maintenance due"
        subtitle={<>{overdueCount} overdue · {dueSoonCount} due soon</>}
        actions={
          <>
            {canManage && (
              <Button variant="outline" size="sm" onClick={handleNotify} disabled={notifyState === 'sending'}>
                <Mail className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                {notifyState === 'sending' ? 'Sending…' : 'Notify owners/managers'}
              </Button>
            )}
            {canManage && <Button onClick={() => setCreateOpen(true)}>+ Add item</Button>}
          </>
        }
      />

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
          <div className="space-y-1">
            <label htmlFor="mi-sort" className="text-xs text-slate-500 font-medium">
              Sort
            </label>
            <select
              id="mi-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'status' | 'remaining')}
              className="flex h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 transition-colors"
            >
              <option value="status">Status</option>
              <option value="remaining">Remaining</option>
            </select>
          </div>
        </div>
      )}

      {/* ── One-click common reminders (owner/manager, aircraft with zero items) ── */}
      {showSeedButton && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 space-y-1.5">
          <p className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">{aircraftName(seedTargetId)}</span> has no
            maintenance reminders yet.
          </p>
          <Button variant="outline" size="sm" onClick={handleSeedCommon} disabled={seedState === 'seeding'}>
            {seedState === 'seeding' ? 'Adding…' : 'Add common reminders'}
          </Button>
          <p className="text-[0.6875rem] text-slate-400">
            Adds 50 Hour Oil Change, 100 Hour Inspection, Annual Inspection, ELT Battery,
            Transponder Check and Pitot/Static Check as plain operator reminder items — each can be
            edited or deactivated individually.
          </p>
          {seedError && (
            <p role="alert" className="text-xs text-destructive">
              {seedError}
            </p>
          )}
        </div>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {filtered.length === 0 && (
        <EmptyState
          icon={CheckCircle}
          title={
            items.length === 0
              ? 'No maintenance items tracked yet.'
              : 'No items match your filters.'
          }
          cta={
            canManage && items.length === 0 && (
              <Button variant="outline" onClick={() => setCreateOpen(true)}>
                Add first item
              </Button>
            )
          }
        />
      )}

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      {filtered.length > 0 && (
        <div className="rounded-md border border-slate-200 overflow-x-auto">
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
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Remaining
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
                    <span className="text-xs text-slate-500 nums">
                      {item.trackBy === 'hours'
                        ? `${item.dueValueHours ?? '—'} ${item.meterBasis ?? ''} hrs`
                        : item.dueDate ?? '—'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <RemainingBar item={item} />
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
