/**
 * preview-panel.tsx — Renders the previewAutoSchedule result.
 *
 * States:
 *   idle       → not shown (no demands entered yet)
 *   loading    → skeleton while the preview is in-flight
 *   populated  → summary counts + proposal table + unschedulable list
 *   error      → inline error alert
 *
 * The preview is advisory only. "Commit schedule" is the single deliberate
 * action here — auto-commit is explicitly forbidden (spec §4b.3).
 *
 * A11y: aria-live="polite" announces updates to screen readers.
 */
'use client';

import * as React from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  CalendarCheck,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { SerializedPreviewResult, SerializedPreviewProposal } from '../actions';
import type { ResourceRow } from '@aeroops/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PreviewState = 'idle' | 'loading' | 'populated' | 'error';

interface PreviewPanelProps {
  state: PreviewState;
  preview: SerializedPreviewResult | null;
  errorMessage: string | null;
  resources: ResourceRow[];
  onCommit: () => void;
  isCommitting: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function formatTimeRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const datePart = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(start);
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${datePart} ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
}

function resourceNames(ids: string[], resources: ResourceRow[]): string {
  return ids
    .map((id) => {
      const r = resources.find((r) => r.id === id);
      if (!r) return id.slice(0, 8);
      return r.tailNumber ? `${r.tailNumber} (${r.displayName})` : r.displayName;
    })
    .join(', ');
}

function skipReasonLabel(reason?: string): string {
  switch (reason) {
    case 'conflict': return 'Conflict';
    case 'policy': return 'Policy violation';
    case 'conflict_and_policy': return 'Conflict + policy';
    case 'twilight': return 'Civil twilight block';
    default: return 'Skipped';
  }
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function PreviewSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading preview">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-8 w-48" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

// ─── ProposalRow ──────────────────────────────────────────────────────────────

function ProposalRow({
  proposal,
  resources,
}: {
  proposal: SerializedPreviewProposal;
  resources: ResourceRow[];
}) {
  const isCreate = proposal.wouldResult === 'create';
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-3 align-top">
        {isCreate ? (
          <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" aria-label="Would create" />
        ) : (
          <XCircle className="h-4 w-4 text-slate-400 mt-0.5" aria-label="Would skip" />
        )}
      </td>
      <td className="py-2 pr-3 text-sm font-mono text-slate-600 align-top whitespace-nowrap nums">
        {formatTimeRange(proposal.startAt, proposal.endAt)}
      </td>
      <td className="py-2 pr-3 text-sm text-slate-700 align-top">
        {resourceNames(proposal.resourceIds, resources)}
      </td>
      <td className="py-2 text-sm align-top">
        {isCreate ? (
          <Badge
            variant="outline"
            className="text-green-700 border-green-200 bg-green-50"
          >
            Would create
          </Badge>
        ) : (
          <div className="space-y-0.5">
            <Badge
              variant="outline"
              className="text-slate-500 border-slate-200"
            >
              {skipReasonLabel(proposal.reason)}
            </Badge>
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── PreviewPanel ─────────────────────────────────────────────────────────────

export function PreviewPanel({
  state,
  preview,
  errorMessage,
  resources,
  onCommit,
  isCommitting,
}: PreviewPanelProps) {
  if (state === 'idle') return null;

  return (
    <section
      aria-live="polite"
      aria-label="Schedule preview"
      className="space-y-4"
    >
      <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
        <CalendarCheck className="h-5 w-5 text-brand" aria-hidden="true" />
        Preview
      </h2>

      {/* Loading */}
      {state === 'loading' && <PreviewSkeleton />}

      {/* Error */}
      {state === 'error' && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {errorMessage ?? 'Preview failed. Please check your inputs and try again.'}
          </AlertDescription>
        </Alert>
      )}

      {/* Populated */}
      {state === 'populated' && preview && (
        <div className="space-y-4">
          {/* Summary strip */}
          <div className="rounded border border-slate-200 bg-slate-50 p-4 flex flex-wrap gap-6">
            <div className="text-center">
              <div className="nums text-2xl font-bold text-green-700">
                {preview.wouldCreateCount}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">Would schedule</div>
            </div>
            <div className="text-center">
              <div className="nums text-2xl font-bold text-slate-500">
                {preview.wouldSkipCount}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">Would skip</div>
            </div>
            <div className="text-center">
              <div className="nums text-2xl font-bold text-slate-500">
                {preview.unschedulable.length}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">Unschedulable</div>
            </div>
          </div>

          {/* Empty state: no proposals and no unschedulable */}
          {preview.proposals.length === 0 && preview.unschedulable.length === 0 && (
            <Alert>
              <AlertDescription>
                No demands were entered. Add sessions above and click Preview.
              </AlertDescription>
            </Alert>
          )}

          {/* Proposals table */}
          {preview.proposals.length > 0 && (
            <div className="rounded border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full text-left" data-tabular>
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="py-2 pl-3 pr-2 text-xs font-medium text-slate-500 w-8" aria-label="Status" />
                    <th className="py-2 pr-3 text-xs font-medium text-slate-500">Window</th>
                    <th className="py-2 pr-3 text-xs font-medium text-slate-500">Resources</th>
                    <th className="py-2 pr-3 text-xs font-medium text-slate-500">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.proposals.map((p, i) => (
                    <ProposalRow
                      key={`${p.demandId}-${i}`}
                      proposal={p}
                      resources={resources}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Unschedulable demands */}
          {preview.unschedulable.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-800">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {preview.unschedulable.length} demand{preview.unschedulable.length !== 1 ? 's' : ''} could not be placed
              </div>
              <ul className="space-y-1" role="list">
                {preview.unschedulable.map((u) => (
                  <li key={u.demandId} className="text-xs text-amber-800">
                    <span className="font-mono nums">{u.demandId}</span>
                    {' — '}
                    {u.reason === 'no_feasible_window'
                      ? 'No feasible window in the scheduling range'
                      : 'Over-constrained (window too narrow or resources fully booked)'}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-amber-700">
                Committing will still schedule the sessions that can be placed.
                Unschedulable demands are skipped non-fatally.
              </p>
            </div>
          )}

          {/* Commit action — explicit deliberate step; never auto-commits */}
          {preview.wouldCreateCount > 0 && (
            <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-100">
              <p className="text-xs text-slate-500">
                Review the preview above, then commit to create {preview.wouldCreateCount}{' '}
                reservation{preview.wouldCreateCount !== 1 ? 's' : ''}.
                {preview.wouldSkipCount > 0 && ` ${preview.wouldSkipCount} will be skipped due to conflicts or policy.`}
              </p>
              <Button
                type="button"
                onClick={onCommit}
                disabled={isCommitting}
                className="min-w-[160px] shrink-0"
                isLoading={isCommitting}
              >
                Commit schedule
              </Button>
            </div>
          )}

          {/* When nothing would create, inform user */}
          {preview.wouldCreateCount === 0 && preview.proposals.length > 0 && (
            <Alert>
              <AlertDescription>
                No sessions can be scheduled with the current inputs. All proposed
                windows conflict with existing reservations or violate booking policies.
                Adjust the demands or scheduling window and preview again.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}
