/**
 * commit-panel.tsx — Post-commit result screen for runAutoSchedule.
 *
 * Shows:
 *   - Created count + skipped count + unschedulable count
 *   - Per-proposal outcome table (created with reservation link / skipped with reason)
 *   - Unschedulable demands with reason
 *   - Staff hand-off note: "Staff can now adjust on the board"
 *   - Link to the dispatch board
 *
 * Refusals (skipped proposals) are non-fatal — the batch still committed the rest.
 * This is made explicit in the UI copy.
 *
 * A11y: role=status on the heading so screen readers announce the outcome.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  LayoutGrid,
  RotateCcw,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { SerializedCommitResult, SerializedCommitProposal } from '../actions';
import type { ResourceRow } from '@aeroops/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommitPanelProps {
  result: SerializedCommitResult;
  resources: ResourceRow[];
  slug: string;
  onReset: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function boardDateFromIso(iso: string): string {
  // Extract YYYY-MM-DD from ISO string for the board ?date= param
  return iso.slice(0, 10);
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
    case 'conflict': return 'Conflict at commit';
    case 'policy': return 'Policy violation at commit';
    case 'conflict_and_policy': return 'Conflict + policy at commit';
    case 'twilight': return 'Civil twilight block at commit';
    default: return 'Skipped';
  }
}

// ─── CommitProposalRow ────────────────────────────────────────────────────────

function CommitProposalRow({
  proposal,
  resources,
  slug,
}: {
  proposal: SerializedCommitProposal;
  resources: ResourceRow[];
  slug: string;
}) {
  const isCreated = proposal.result === 'created';
  const boardDate = boardDateFromIso(proposal.startAt);

  return (
    <tr className="border-b border-slate-100 dark:border-slate-800 last:border-0">
      <td className="py-2 pr-3 align-top">
        {isCreated ? (
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5" aria-label="Created" />
        ) : (
          <XCircle className="h-4 w-4 text-slate-400 dark:text-slate-500 mt-0.5" aria-label="Skipped" />
        )}
      </td>
      <td className="py-2 pr-3 text-sm text-slate-600 dark:text-slate-300 align-top whitespace-nowrap nums">
        {formatTimeRange(proposal.startAt, proposal.endAt)}
      </td>
      <td className="py-2 pr-3 text-sm text-slate-700 dark:text-slate-300 align-top">
        {resourceNames(proposal.resourceIds, resources)}
      </td>
      <td className="py-2 text-sm align-top">
        {isCreated ? (
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-green-700 dark:text-green-300 border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40"
            >
              Created
            </Badge>
            {proposal.reservationId && (
              <Link
                href={`/o/${slug}/schedule/board?date=${boardDate}`}
                className="text-xs text-brand hover:underline"
              >
                View on board
              </Link>
            )}
          </div>
        ) : (
          <Badge variant="outline" className="text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-800">
            {skipReasonLabel(proposal.reason)}
          </Badge>
        )}
      </td>
    </tr>
  );
}

// ─── CommitPanel ─────────────────────────────────────────────────────────────

export function CommitPanel({ result, resources, slug, onReset }: CommitPanelProps) {
  const hasCreated = result.createdCount > 0;
  const hasSkipped = result.skippedCount > 0;
  const hasUnschedulable = result.unschedulable.length > 0;

  // For the "View on board" link, use the first created proposal's date
  const firstCreatedDate = result.proposals.find((p) => p.result === 'created')?.startAt;
  const boardDate = firstCreatedDate ? boardDateFromIso(firstCreatedDate) : '';

  return (
    <section className="space-y-6" aria-label="Auto-schedule commit result">
      {/* Outcome heading */}
      <div
        role="status"
        aria-live="assertive"
        className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
      >
        <div className="flex items-start gap-3">
          {hasCreated ? (
            <CheckCircle2
              className="h-6 w-6 text-green-600 dark:text-green-400 mt-0.5 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className="h-6 w-6 text-amber-500 dark:text-amber-400 mt-0.5 shrink-0"
              aria-hidden="true"
            />
          )}
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {hasCreated
                ? `${result.createdCount} session${result.createdCount !== 1 ? 's' : ''} scheduled`
                : 'No sessions were scheduled'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {hasCreated && hasSkipped
                ? `${result.skippedCount} additional proposal${result.skippedCount !== 1 ? 's' : ''} were skipped due to conflicts or policy violations — the rest committed successfully.`
                : hasCreated
                  ? 'All proposed sessions were committed successfully.'
                  : 'All proposals were refused by conflict detection, booking policies, or the civil-twilight gate.'}
              {hasUnschedulable &&
                ` ${result.unschedulable.length} demand${result.unschedulable.length !== 1 ? 's' : ''} could not be placed at all.`}
            </p>
          </div>
        </div>

        {/* Summary counts */}
        <div className="flex flex-wrap gap-6 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="text-center">
            <div className="nums text-2xl font-bold text-green-700 dark:text-green-300">
              {result.createdCount}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Created</div>
          </div>
          {hasSkipped && (
            <div className="text-center">
              <div className="nums text-2xl font-bold text-slate-500 dark:text-slate-400">
                {result.skippedCount}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Skipped <span className="text-slate-400 dark:text-slate-500">(non-fatal)</span>
              </div>
            </div>
          )}
          {hasUnschedulable && (
            <div className="text-center">
              <div className="nums text-2xl font-bold text-slate-400 dark:text-slate-500">
                {result.unschedulable.length}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Unschedulable</div>
            </div>
          )}
        </div>
      </div>

      {/* Staff hand-off note */}
      {hasCreated && (
        <Alert className="border-brand/30 bg-brand/5">
          <AlertDescription className="text-sm text-slate-700 dark:text-slate-300">
            <strong className="text-slate-900 dark:text-slate-100">Staff can now adjust on the board.</strong>{' '}
            Use the dispatch board to drag-and-drop reservations to fine-tune timing,
            or open individual reservations to edit details.
          </AlertDescription>
        </Alert>
      )}

      {/* Proposals table */}
      {result.proposals.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Proposals ({result.proposals.length})
          </h3>
          <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <table className="w-full text-left" data-tabular>
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
                  <th className="py-2 pl-3 pr-2 text-xs font-medium text-slate-500 dark:text-slate-400 w-8" aria-label="Status" />
                  <th className="py-2 pr-3 text-xs font-medium text-slate-500 dark:text-slate-400">Window</th>
                  <th className="py-2 pr-3 text-xs font-medium text-slate-500 dark:text-slate-400">Resources</th>
                  <th className="py-2 pr-3 text-xs font-medium text-slate-500 dark:text-slate-400">Result</th>
                </tr>
              </thead>
              <tbody>
                {result.proposals.map((p, i) => (
                  <CommitProposalRow
                    key={`${p.demandId}-${i}`}
                    proposal={p}
                    resources={resources}
                    slug={slug}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Skipped rationale note — make explicit these are non-fatal */}
      {hasSkipped && (
        <Alert>
          <AlertDescription className="text-sm">
            <strong>Skipped proposals are non-fatal.</strong>{' '}
            When reality changed between preview and commit (another booking was made,
            or a race condition occurred), the system skipped those sessions and
            committed everything else. You can run another auto-schedule pass or book
            the remaining sessions manually.
          </AlertDescription>
        </Alert>
      )}

      {/* Unschedulable demands */}
      {hasUnschedulable && (
        <div className="rounded border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {result.unschedulable.length} demand{result.unschedulable.length !== 1 ? 's' : ''} could not be placed
          </div>
          <ul className="space-y-1" role="list">
            {result.unschedulable.map((u) => (
              <li key={u.demandId} className="text-xs text-amber-800 dark:text-amber-200">
                <span className="font-mono nums">{u.demandId}</span>
                {' — '}
                {u.reason === 'no_feasible_window'
                  ? 'No feasible window in the scheduling range'
                  : 'Over-constrained (window too narrow or resources fully booked)'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        {hasCreated && boardDate && (
          <Button asChild>
            <Link href={`/o/${slug}/schedule/board?date=${boardDate}`}>
              <LayoutGrid className="h-4 w-4 mr-2" aria-hidden="true" />
              View on board
            </Link>
          </Button>
        )}
        <Button variant="outline" onClick={onReset}>
          <RotateCcw className="h-4 w-4 mr-2" aria-hidden="true" />
          Schedule again
        </Button>
      </div>
    </section>
  );
}
