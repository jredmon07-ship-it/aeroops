/**
 * open-work-orders-card.tsx — "Open work orders" facet card for fleet detail
 * page (Slice M1.3, [VERIFY-M1-E]).
 *
 * Renders the openWorkOrders list from AircraftDetail (≤10, newest-first).
 * Each row links to /maintenance/work-orders/[id].
 * "Open work order" button gated by maintenance:work_order.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Wrench, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OpenWorkOrderDialog } from '../../maintenance/work-orders/_components/open-work-order-dialog';
import type { SerializedWorkOrderView } from '../actions';
import type { AircraftListRow } from '@aeroops/api';

// ─── Status mini-chip ─────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    open: { label: 'Open', cls: 'border-brand/30 bg-brand/8 text-brand-ink' },
    in_progress: { label: 'In progress', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  };
  const conf = map[status] ?? { label: status, cls: 'border-slate-200 bg-slate-50 text-slate-500' };
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1 py-0.5 text-[10px] font-semibold leading-4 ${conf.cls}`}
    >
      {conf.label}
    </span>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface OpenWorkOrdersCardProps {
  resourceId: string;
  openWorkOrders: SerializedWorkOrderView[];
  openWorkOrderCount: number;
  aircraft: AircraftListRow[];
  slug: string;
  canWorkOrder: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OpenWorkOrdersCard({
  resourceId,
  openWorkOrders,
  openWorkOrderCount,
  aircraft,
  slug,
  canWorkOrder,
}: OpenWorkOrdersCardProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [localWorkOrders, setLocalWorkOrders] = React.useState(openWorkOrders);

  function handleOpenSuccess(wo: SerializedWorkOrderView) {
    setLocalWorkOrders((prev) => [wo, ...prev]);
  }

  const displayCount = openWorkOrderCount || localWorkOrders.length;

  return (
    <>
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-700">Open Work Orders</h2>
            {displayCount > 0 && (
              <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[10px] font-semibold text-brand-ink">
                {displayCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/o/${slug}/maintenance/work-orders?resourceId=${resourceId}`}
              className="text-xs text-brand hover:text-brand-ink underline underline-offset-2"
            >
              View all work orders
            </Link>
            {canWorkOrder && (
              <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
                + Open work order
              </Button>
            )}
          </div>
        </div>

        {localWorkOrders.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No open work orders.</p>
        ) : (
          <div className="space-y-1.5">
            {localWorkOrders.map((wo) => (
              <div
                key={wo.id}
                className="flex items-start justify-between gap-2 rounded-md bg-slate-50 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      href={`/o/${slug}/maintenance/work-orders/${wo.id}`}
                      className="text-sm font-medium text-slate-800 hover:text-brand hover:underline underline-offset-2 truncate"
                    >
                      {wo.title}
                    </Link>
                    <StatusChip status={wo.status} />
                    {wo.squawkId && (
                      <span
                        className="inline-flex items-center gap-0.5 text-[10px] text-amber-700"
                        title="Linked to a squawk"
                      >
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      </span>
                    )}
                  </div>
                  {wo.description && (
                    <p className="text-xs text-slate-500 truncate">{wo.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <OpenWorkOrderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        aircraft={aircraft}
        preselectResourceId={resourceId}
        onSuccess={handleOpenSuccess}
      />
    </>
  );
}
