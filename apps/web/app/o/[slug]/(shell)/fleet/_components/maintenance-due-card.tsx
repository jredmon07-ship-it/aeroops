/**
 * maintenance-due-card.tsx — "Maintenance due" facet card for fleet detail
 * page (Slice P1.5).
 *
 * Renders the due items for ONE aircraft (fetched separately from
 * AircraftDetail — see fleet/[id]/page.tsx DetailContent). Overdue/due-soon
 * items surface first (list is pre-sorted by listMaintenanceDue). "+ Add
 * item" / "Mark serviced" / "Deactivate" gated on canManage
 * (maintenance:work_order).
 *
 * COMPLIANCE: verbatim disclaimer — operator-entered tracking data, NOT a
 * computed Part-43/91.409 airworthiness or inspection-due determination.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Wrench, AlertTriangle, Clock, CheckCircle, HelpCircle } from 'lucide-react';
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
import { MaintenanceItemDialog } from '../../maintenance/due/_components/maintenance-item-dialog';
import { MarkServicedDialog } from '../../maintenance/due/_components/mark-serviced-dialog';
import { deactivateMaintenanceItemAction } from '../../maintenance/due-actions';
import type { SerializedMaintenanceDueView } from '../../maintenance/due-actions';
import type { AircraftListRow } from '@aeroops/api';
import type { MaintenanceDueStatus } from '@aeroops/core';

// ─── Status mini-chip ─────────────────────────────────────────────────────────

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
      label: 'No meter yet',
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

// ─── Props ────────────────────────────────────────────────────────────────────

interface MaintenanceDueCardProps {
  resourceId: string;
  items: SerializedMaintenanceDueView[];
  aircraft: AircraftListRow[];
  slug: string;
  canManage: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MaintenanceDueCard({ resourceId, items, aircraft, slug, canManage }: MaintenanceDueCardProps) {
  const [localItems, setLocalItems] = React.useState(items);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [serviceTarget, setServiceTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [deactivateTarget, setDeactivateTarget] = React.useState<SerializedMaintenanceDueView | null>(null);
  const [isDeactivating, setIsDeactivating] = React.useState(false);
  const [deactivateError, setDeactivateError] = React.useState<string | null>(null);

  const dueCount = localItems.filter((i) => i.status === 'overdue' || i.status === 'due_soon').length;

  // AircraftListRow doesn't carry tailNumber/displayName in the shape needed
  // by the create dialog's select — the dialog is only used here in
  // preselected mode (resourceId fixed), so the select list is unused, but
  // ResourceRow's shape (tailNumber/displayName/id/kind/active) is required
  // by the dialog's prop type; pass an empty list since the select is hidden
  // when preselectResourceId is set.
  const emptyResourceList: import('@aeroops/api').ResourceRow[] = [];
  void aircraft;

  async function handleDeactivateConfirm() {
    if (!deactivateTarget) return;
    setIsDeactivating(true);
    setDeactivateError(null);
    try {
      const result = await deactivateMaintenanceItemAction({ itemId: deactivateTarget.id });
      if ('error' in result || !result.ok) {
        setDeactivateError('Could not deactivate this item. Please try again.');
        return;
      }
      setLocalItems((prev) => prev.filter((i) => i.id !== deactivateTarget.id));
      setDeactivateTarget(null);
    } catch {
      setDeactivateError('Could not deactivate this item. Please try again.');
    } finally {
      setIsDeactivating(false);
    }
  }

  return (
    <>
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-700">Maintenance due</h2>
            {dueCount > 0 && (
              <span className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-destructive">
                {dueCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/o/${slug}/maintenance/due?resourceId=${resourceId}`}
              className="text-xs text-brand hover:text-brand-ink underline underline-offset-2"
            >
              View all
            </Link>
            {canManage && (
              <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                + Add item
              </Button>
            )}
          </div>
        </div>

        {localItems.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No maintenance items tracked.</p>
        ) : (
          <div className="space-y-1.5">
            {localItems.map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-2 rounded-md bg-slate-50 px-3 py-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-800 truncate">{item.title}</span>
                    <StatusChip status={item.status} />
                  </div>
                  <p className="text-xs text-slate-500">
                    {item.trackBy === 'hours'
                      ? `Due at ${item.dueValueHours ?? '—'} ${item.meterBasis ?? ''} hrs`
                      : `Due ${item.dueDate ?? '—'}`}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-1 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => setServiceTarget(item)}>
                      Mark serviced
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
              </div>
            ))}
          </div>
        )}

        <p className="text-[0.6875rem] text-slate-400">
          Operator-entered tracking data — not a computed Part-43/91.409 airworthiness or
          inspection-due determination.
        </p>
      </div>

      <MaintenanceItemDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode="create"
        aircraft={emptyResourceList}
        preselectResourceId={resourceId}
        onSuccess={(created) =>
          setLocalItems((prev) => [
            {
              ...(created as unknown as SerializedMaintenanceDueView),
              status: 'unknown',
              currentHobbs: null,
              currentTach: null,
            },
            ...prev,
          ])
        }
      />

      {serviceTarget && (
        <MarkServicedDialog
          open={!!serviceTarget}
          onOpenChange={(o) => !o && setServiceTarget(null)}
          item={serviceTarget}
          onSuccess={(updated) => {
            setLocalItems((prev) => prev.map((i) => (i.id === updated.id ? { ...i, ...updated, status: 'ok' } : i)));
            setServiceTarget(null);
          }}
        />
      )}

      <AlertDialog open={!!deactivateTarget} onOpenChange={(o) => !o && setDeactivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate &ldquo;{deactivateTarget?.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops tracking the item. It can be added again later.
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
    </>
  );
}
