/**
 * work-order-detail-client.tsx — Work order detail client component.
 *
 * Renders the status-dependent actions (Start / Complete / Cancel).
 * Reads aircraft grounding from the serialized aircraft detail to determine
 * unground eligibility.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 * [VERIFY-M1-A/C/D]: compliance disclaimers in CompleteWorkOrderDialog.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, WrenchIcon, AlertTriangle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { WorkOrderStatusBadge } from './work-order-status-badge';
import { CompleteWorkOrderDialog, CompleteResultPanel } from './complete-work-order-dialog';
import { CancelWorkOrderDialog } from './cancel-work-order-dialog';
import { formatDateTime, isTerminalStatus } from './work-order-utils';
import { updateWorkOrderStatusAction } from '../actions';
import type { SerializedWorkOrderView, SerializedSquawkView, SerializedCompleteWorkOrderResult } from '../actions';

// ─── Props ────────────────────────────────────────────────────────────────────

interface WorkOrderDetailClientProps {
  workOrder: SerializedWorkOrderView;
  linkedSquawk: SerializedSquawkView | null;
  /** Whether the aircraft is currently grounded. */
  isGrounded: boolean;
  /**
   * Whether the active grounding basis (squawk_id) matches this WO's squawk_id.
   * Used to enable/disable the unground checkbox.
   */
  groundingMatchesSquawk: boolean;
  /** squawk_id on the active grounding event (for matching). */
  groundingSquawkId: string | null;
  slug: string;
  canWorkOrder: boolean;
  canResolveSquawk: boolean;
  canUnground: boolean;
}

// ─── Severity chip ────────────────────────────────────────────────────────────

function SeverityChip({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    low: 'border-slate-200 bg-slate-50 text-slate-600',
    medium: 'border-amber-200 bg-amber-50 text-amber-800',
    high: 'border-orange-200 bg-orange-50 text-orange-800',
    grounding: 'border-destructive/30 bg-destructive/10 text-destructive',
  };
  const cls = map[severity] ?? 'border-slate-200 bg-slate-50 text-slate-600';
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${cls}`}
    >
      {label}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WorkOrderDetailClient({
  workOrder: initialWorkOrder,
  linkedSquawk,
  isGrounded,
  groundingMatchesSquawk,
  slug,
  canWorkOrder,
  canResolveSquawk,
  canUnground,
}: WorkOrderDetailClientProps) {
  const [workOrder, setWorkOrder] = React.useState(initialWorkOrder);
  const [completeOpen, setCompleteOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [isStarting, setIsStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);

  // Complete result state (shown after completion)
  const [completeResult, setCompleteResult] =
    React.useState<Extract<SerializedCompleteWorkOrderResult, { ok: true }> | null>(null);
  const [requestedResolveSquawk, setRequestedResolveSquawk] = React.useState(false);
  const [requestedUnground, setRequestedUnground] = React.useState(false);

  const terminal = isTerminalStatus(workOrder.status);

  async function handleStartWork() {
    setStartError(null);
    setIsStarting(true);
    try {
      const result = await updateWorkOrderStatusAction({
        workOrderId: workOrder.id,
        status: 'in_progress',
      });

      if ('error' in result) {
        setStartError('Could not start work. Please try again.');
        return;
      }
      if (!result.ok) {
        if (result.reason === 'invalid_transition') {
          setStartError('Work order is no longer in open state.');
        } else {
          setStartError('Work order not found.');
        }
        return;
      }
      setWorkOrder(result.workOrder);
    } catch {
      setStartError('Could not start work. Please try again.');
    } finally {
      setIsStarting(false);
    }
  }

  function handleCompleteSuccess(
    result: Extract<SerializedCompleteWorkOrderResult, { ok: true }>,
  ) {
    setWorkOrder(result.workOrder);
    setCompleteResult(result);
    // Track what was requested for the result panel
    setRequestedResolveSquawk(
      !!(linkedSquawk && (linkedSquawk.status === 'open' || linkedSquawk.status === 'deferred'))
    );
    setRequestedUnground(isGrounded && groundingMatchesSquawk && canUnground);
  }

  function handleCancelSuccess(cancelled: SerializedWorkOrderView) {
    setWorkOrder(cancelled);
  }

  return (
    <div className="space-y-6">
      {/* ── Back link ──────────────────────────────────────────────────────── */}
      <div>
        <Link
          href={`/o/${slug}/maintenance/work-orders`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Work orders
        </Link>
      </div>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 truncate">{workOrder.title}</h1>
            <WorkOrderStatusBadge status={workOrder.status} />
          </div>
          <p className="text-sm text-slate-500">
            Aircraft:{' '}
            <Link
              href={`/o/${slug}/fleet/${workOrder.resourceId}`}
              className="font-mono nums text-brand hover:text-brand-ink underline underline-offset-2"
            >
              {workOrder.resourceId}
            </Link>
          </p>
          <p className="text-xs text-slate-400">
            Opened {formatDateTime(workOrder.openedAt)}
          </p>
        </div>

        {/* ── Status-dependent actions ──────────────────────────────────── */}
        {canWorkOrder && !terminal && (
          <div className="flex flex-wrap gap-2">
            {workOrder.status === 'open' && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleStartWork}
                disabled={isStarting}
              >
                {isStarting ? 'Starting…' : 'Start work'}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => setCompleteOpen(true)}
              disabled={isStarting}
            >
              Complete
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setCancelOpen(true)}
              disabled={isStarting}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* ── Start error ───────────────────────────────────────────────────── */}
      {startError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{startError}</AlertDescription>
        </Alert>
      )}

      {/* ── Complete result panel ─────────────────────────────────────────── */}
      {completeResult && (
        <CompleteResultPanel
          result={completeResult}
          requestedResolveSquawk={requestedResolveSquawk}
          requestedUnground={requestedUnground}
        />
      )}

      {/* ── Linked squawk panel ───────────────────────────────────────────── */}
      {linkedSquawk && (
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-700">Linked Squawk</h2>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-100 px-3 py-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-slate-900">{linkedSquawk.title}</p>
              <SeverityChip severity={linkedSquawk.severity} />
              <span
                className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${
                  linkedSquawk.status === 'open'
                    ? 'border-brand/30 bg-brand/8 text-brand-ink'
                    : linkedSquawk.status === 'deferred'
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-green-200 bg-green-50 text-green-800'
                }`}
              >
                {linkedSquawk.status === 'open'
                  ? 'Open'
                  : linkedSquawk.status === 'deferred'
                  ? 'Deferred'
                  : 'Resolved'}
              </span>
            </div>
            {linkedSquawk.description && (
              <p className="text-xs text-slate-500">{linkedSquawk.description}</p>
            )}
            {linkedSquawk.resolutionNotes && (
              <p className="text-xs text-slate-500 italic">
                Resolution: {linkedSquawk.resolutionNotes}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Description ───────────────────────────────────────────────────── */}
      {workOrder.description && (
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-1.5">
          <h2 className="text-sm font-semibold text-slate-700">Description</h2>
          <p className="text-sm text-slate-600 whitespace-pre-wrap">{workOrder.description}</p>
        </div>
      )}

      {/* ── Work performed ────────────────────────────────────────────────── */}
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-1.5">
        <div className="flex items-center gap-2">
          <WrenchIcon className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-700">Work Performed</h2>
        </div>
        {workOrder.workPerformed ? (
          <p className="text-sm text-slate-600 whitespace-pre-wrap">{workOrder.workPerformed}</p>
        ) : (
          <p className="text-sm text-slate-400 italic">No work performed notes.</p>
        )}
      </div>

      {/* ── Sign-off block (completed only) ──────────────────────────────── */}
      {workOrder.status === 'completed' && (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-600" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-green-900">Sign-off Record</h2>
          </div>
          <div className="text-sm space-y-1">
            {workOrder.signedOffBy ? (
              <p className="text-green-800">
                Signed off by{' '}
                <span className="font-mono text-xs">{workOrder.signedOffBy}</span>
              </p>
            ) : (
              <p className="text-green-700 italic">Signer not recorded (account removed).</p>
            )}
            {workOrder.signedOffAt && (
              <p className="text-green-700 text-xs">{formatDateTime(workOrder.signedOffAt)}</p>
            )}
            {workOrder.signOffNotes && (
              <p className="text-green-800 text-sm mt-1 whitespace-pre-wrap">
                {workOrder.signOffNotes}
              </p>
            )}
          </div>
          {/* MANDATORY compliance disclaimer [VERIFY-M1-A/C] */}
          <p className="text-[10px] text-green-700 italic border-t border-green-200 pt-2">
            This sign-off is an operator/mechanic maintenance record — it is NOT an FAA
            return-to-service or §43.9/§43.11 determination, and the system makes no
            airworthiness determination.
          </p>
        </div>
      )}

      {/* ── Cancelled block (cancelled only) ──────────────────────────────── */}
      {workOrder.status === 'cancelled' && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4 space-y-1.5">
          <h2 className="text-sm font-semibold text-slate-700">Cancelled</h2>
          <p className="text-sm text-slate-600">
            <span className="font-medium">Reason:</span>{' '}
            {workOrder.cancelledReason ?? '—'}
          </p>
          {workOrder.cancelledAt && (
            <p className="text-xs text-slate-400">{formatDateTime(workOrder.cancelledAt)}</p>
          )}
          <p className="text-xs text-slate-400 italic">
            Cancellation does not resolve squawks or return the aircraft to service.
          </p>
        </div>
      )}

      {/* ── Complete dialog ────────────────────────────────────────────────── */}
      {canWorkOrder && !terminal && (
        <>
          <CompleteWorkOrderDialog
            open={completeOpen}
            onOpenChange={setCompleteOpen}
            workOrder={workOrder}
            linkedSquawk={linkedSquawk}
            isGrounded={isGrounded}
            groundingMatchesSquawk={groundingMatchesSquawk}
            canResolveSquawk={canResolveSquawk}
            canUnground={canUnground}
            onSuccess={handleCompleteSuccess}
          />
          <CancelWorkOrderDialog
            open={cancelOpen}
            onOpenChange={setCancelOpen}
            workOrder={workOrder}
            onSuccess={handleCancelSuccess}
          />
        </>
      )}
    </div>
  );
}
