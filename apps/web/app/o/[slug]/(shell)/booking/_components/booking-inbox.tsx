/**
 * booking-inbox.tsx — Client component for the booking-request triage inbox.
 *
 * States: loading (skeleton at page level) / empty / populated / error.
 *
 * Primary action per status:
 *   new       → "Mark contacted" (primary) + "Decline" (destructive, confirm step)
 *   contacted → "Mark converted" (primary) + "Decline" (destructive) + re-note option
 *   terminal  → read-only; shows handler name + time
 *
 * Status tabs show the four per-status counts from the API.
 * Each action optionally collects a triageNotes via an inline note field.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 * Dates are pre-serialized to ISO strings at the action boundary.
 */
'use client';

import * as React from 'react';
import { Inbox, AlertCircle, CheckCircle2, PhoneCall, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { BookingStatusBadge } from './booking-status-badge';
import { isTerminalStatus, formatRequestedDate } from './booking-utils';
import { formatRelativeTime } from '@/lib/activity-utils';
import {
  listBookingRequestsAction,
  updateBookingRequestStatusAction,
} from '../actions';
import type { SerializedBookingRequestRow, SerializedListBookingRequestsResult } from '../actions';

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveStatus = 'new' | 'contacted' | 'converted' | 'declined';

interface BookingInboxProps {
  /** Initial data from the RSC (status='new'). */
  initial: SerializedListBookingRequestsResult;
  slug: string;
}

// ─── Status tab config ────────────────────────────────────────────────────────

const STATUS_TABS: { value: ActiveStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'converted', label: 'Converted' },
  { value: 'declined', label: 'Declined' },
];

// ─── Action dialog ─────────────────────────────────────────────────────────────

interface ActionDialogState {
  open: boolean;
  requestId: string;
  requestName: string;
  newStatus: 'contacted' | 'converted' | 'declined';
  /** Whether this is a destructive confirm (decline). */
  isDecline: boolean;
}

const CLOSED_DIALOG: ActionDialogState = {
  open: false,
  requestId: '',
  requestName: '',
  newStatus: 'contacted',
  isDecline: false,
};

// ─── Inline non-fatal error message ──────────────────────────────────────────

function InlineErrorMessage({ reason }: { reason: 'not_found' | 'invalid_transition' | 'other' }) {
  const msg =
    reason === 'not_found'
      ? 'This request no longer exists, refreshing.'
      : reason === 'invalid_transition'
        ? "That status change isn't allowed."
        : 'Something went wrong. Please try again.';
  return (
    <Alert variant="destructive" role="alert" className="mb-4">
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      <AlertDescription>{msg}</AlertDescription>
    </Alert>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BookingInbox({ initial, slug }: BookingInboxProps) {
  // Active status tab
  const [activeStatus, setActiveStatus] = React.useState<ActiveStatus>('new');

  // Per-status counts (refreshed when list is re-fetched)
  const [counts, setCounts] = React.useState(initial.counts);

  // Rows for the currently visible status tab
  const [rows, setRows] = React.useState<SerializedBookingRequestRow[]>(
    initial.rows,
  );

  // Loading state for tab switches
  const [tabLoading, setTabLoading] = React.useState(false);

  // Action dialog
  const [dialog, setDialog] = React.useState<ActionDialogState>(CLOSED_DIALOG);
  const [triageNotes, setTriageNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [inlineError, setInlineError] = React.useState<
    'not_found' | 'invalid_transition' | 'other' | null
  >(null);

  // ── Tab switch ──────────────────────────────────────────────────────────────

  async function handleTabSwitch(status: ActiveStatus) {
    if (status === activeStatus) return;
    setActiveStatus(status);
    setTabLoading(true);
    setInlineError(null);
    try {
      const result = await listBookingRequestsAction({ status });
      if ('error' in result) {
        // Show a soft error but still switch tabs
        setRows([]);
      } else {
        setRows(result.rows);
        setCounts(result.counts);
      }
    } catch {
      setRows([]);
    } finally {
      setTabLoading(false);
    }
  }

  // ── Open action dialog ──────────────────────────────────────────────────────

  function openDialog(
    row: SerializedBookingRequestRow,
    newStatus: 'contacted' | 'converted' | 'declined',
  ) {
    setTriageNotes('');
    setInlineError(null);
    setDialog({
      open: true,
      requestId: row.id,
      requestName: row.requesterName,
      newStatus,
      isDecline: newStatus === 'declined',
    });
  }

  // ── Submit action ───────────────────────────────────────────────────────────

  async function handleSubmit() {
    setSubmitting(true);
    setInlineError(null);
    try {
      const result = await updateBookingRequestStatusAction(
        {
          id: dialog.requestId,
          status: dialog.newStatus,
          triageNotes: triageNotes.trim() || undefined,
        },
        slug,
      );

      if ('error' in result) {
        // Auth/server error — surface non-fatally
        setInlineError('other');
        setSubmitting(false);
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_found') {
          setInlineError('not_found');
          // Remove the row from the list (it's gone)
          setRows((prev) => prev.filter((r) => r.id !== dialog.requestId));
        } else {
          setInlineError('invalid_transition');
        }
        setSubmitting(false);
        setDialog(CLOSED_DIALOG);
        return;
      }

      // Success: remove the row from the current tab view (it moved to another status)
      // and refresh counts by re-fetching from the same tab so counts stay accurate.
      setRows((prev) => prev.filter((r) => r.id !== dialog.requestId));
      setDialog(CLOSED_DIALOG);
      setSubmitting(false);

      // Re-fetch counts (background; no spinner needed — rows are already updated)
      listBookingRequestsAction({ status: activeStatus })
        .then((r) => {
          if (!('error' in r)) setCounts(r.counts);
        })
        .catch(() => {
          /* best-effort */
        });
    } catch {
      setInlineError('other');
      setSubmitting(false);
    }
  }

  // ── Dialog title / description ──────────────────────────────────────────────

  function dialogTitle(): string {
    if (dialog.newStatus === 'contacted') return 'Mark as contacted';
    if (dialog.newStatus === 'converted') return 'Mark as converted';
    return 'Decline request';
  }

  function dialogDescription(): string {
    if (dialog.newStatus === 'contacted')
      return `Record that you've contacted ${dialog.requestName}. Add an optional note.`;
    if (dialog.newStatus === 'converted')
      return `Mark this request as converted (booked separately). Add an optional note.`;
    return `Decline the request from ${dialog.requestName}. This cannot be undone. Add an optional note.`;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  const activeCount = counts[activeStatus];
  const emptyLabel: Record<ActiveStatus, string> = {
    new: 'No new requests',
    contacted: 'No contacted requests',
    converted: 'No converted requests',
    declined: 'No declined requests',
  };

  return (
    <div className="space-y-4">
      {/* ── Inline non-fatal error ─────────────────────────────────────────── */}
      {inlineError && <InlineErrorMessage reason={inlineError} />}

      {/* ── Status tabs ────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Filter by status"
        className="flex flex-wrap gap-1 rounded-md border border-slate-200 bg-slate-50 p-1"
      >
        {STATUS_TABS.map((tab) => {
          const isActive = tab.value === activeStatus;
          const count = counts[tab.value];
          return (
            <button
              key={tab.value}
              role="tab"
              aria-selected={isActive}
              aria-controls={`booking-panel-${tab.value}`}
              id={`booking-tab-${tab.value}`}
              onClick={() => { void handleTabSwitch(tab.value); }}
              className={[
                'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
                isActive
                  ? 'bg-white text-slate-900 shadow-xs border border-slate-200'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60',
              ].join(' ')}
            >
              {tab.label}
              {count > 0 && (
                <span
                  className={[
                    'inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none nums',
                    isActive
                      ? 'bg-brand text-white'
                      : 'bg-slate-200 text-slate-600',
                  ].join(' ')}
                  aria-label={`${count} ${tab.label.toLowerCase()} requests`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Tab panel ──────────────────────────────────────────────────────── */}
      <div
        role="tabpanel"
        id={`booking-panel-${activeStatus}`}
        aria-labelledby={`booking-tab-${activeStatus}`}
      >
        {/* Loading state for tab switches */}
        {tabLoading && (
          <div
            className="space-y-2 animate-pulse"
            aria-busy="true"
            aria-label="Loading requests"
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-16 rounded-md bg-slate-100 border border-slate-200"
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!tabLoading && rows.length === 0 && (
          <div
            className="flex flex-col items-center justify-center py-16 text-center space-y-3"
            role="status"
          >
            <Inbox className="h-10 w-10 text-slate-300" aria-hidden="true" />
            <p className="text-slate-500 font-medium">
              {emptyLabel[activeStatus]}
            </p>
            {activeStatus !== 'new' && (
              <p className="text-sm text-slate-400">
                Switch to the{' '}
                <button
                  onClick={() => { void handleTabSwitch('new'); }}
                  className="text-brand underline underline-offset-2 hover:text-brand-ink"
                >
                  New
                </button>{' '}
                tab to see incoming requests.
              </p>
            )}
          </div>
        )}

        {/* Populated — table */}
        {!tabLoading && rows.length > 0 && (
          <div className="rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm" aria-label={`${activeStatus} booking requests`}>
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide"
                  >
                    Requester
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell"
                  >
                    Requested date
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden md:table-cell"
                  >
                    Aircraft pref
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
                    Received
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <BookingRow
                    key={row.id}
                    row={row}
                    onAction={openDialog}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Action dialog ─────────────────────────────────────────────────────
           Decline is destructive → confirm step with explicit warning copy.
           Other transitions → note field + submit.
      ──────────────────────────────────────────────────────────────────────── */}
      <Dialog
        open={dialog.open}
        onOpenChange={(open) => {
          if (!open && !submitting) setDialog(CLOSED_DIALOG);
        }}
      >
        <DialogContent aria-describedby="action-dialog-desc">
          <DialogHeader>
            <DialogTitle>{dialogTitle()}</DialogTitle>
            <DialogDescription id="action-dialog-desc">
              {dialogDescription()}
            </DialogDescription>
          </DialogHeader>

          {/* Optional triage note */}
          <div className="space-y-2 py-2">
            <Label htmlFor="triage-notes" className="text-sm font-medium text-slate-700">
              Note{' '}
              <span className="text-slate-400 font-normal">(optional)</span>
            </Label>
            <Textarea
              id="triage-notes"
              value={triageNotes}
              onChange={(e) => setTriageNotes(e.target.value)}
              placeholder="Add a note about this request…"
              rows={3}
              maxLength={500}
              className="resize-none"
              disabled={submitting}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialog(CLOSED_DIALOG)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={dialog.isDecline ? 'destructive' : 'default'}
              onClick={() => { void handleSubmit(); }}
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting
                ? 'Saving…'
                : dialog.isDecline
                  ? 'Confirm decline'
                  : dialogTitle()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── BookingRow ───────────────────────────────────────────────────────────────

interface BookingRowProps {
  row: SerializedBookingRequestRow;
  onAction: (
    row: SerializedBookingRequestRow,
    newStatus: 'contacted' | 'converted' | 'declined',
  ) => void;
}

function BookingRow({ row, onAction }: BookingRowProps) {
  const terminal = isTerminalStatus(row.status);
  const isNew = row.status === 'new';
  const isContacted = row.status === 'contacted';

  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
      {/* Requester */}
      <td className="px-3 py-3">
        <p className="font-medium text-slate-900 truncate max-w-[160px]">
          {row.requesterName}
        </p>
        <a
          href={`mailto:${row.requesterEmail}`}
          className="text-xs text-brand hover:underline underline-offset-2 truncate block max-w-[160px]"
        >
          {row.requesterEmail}
        </a>
        {row.requesterPhone && (
          <p className="text-xs text-slate-500 nums">{row.requesterPhone}</p>
        )}
        {row.message && (
          <p className="text-xs text-slate-400 truncate max-w-[200px] mt-0.5 italic">
            &ldquo;{row.message}&rdquo;
          </p>
        )}
      </td>

      {/* Requested date */}
      <td className="px-3 py-3 hidden sm:table-cell text-xs text-slate-600">
        {formatRequestedDate(row.requestedStart, row.requestedEnd)}
      </td>

      {/* Aircraft pref */}
      <td className="px-3 py-3 hidden md:table-cell">
        {row.aircraftTypePref ? (
          <span className="text-xs text-slate-700">{row.aircraftTypePref}</span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-3 py-3">
        <BookingStatusBadge status={row.status} />
        {terminal && row.handledAt && (
          <p className="text-[10px] text-slate-400 mt-0.5 nums">
            {formatRelativeTime(row.handledAt)}
          </p>
        )}
        {row.triageNotes && (
          <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-[120px] italic">
            {row.triageNotes}
          </p>
        )}
      </td>

      {/* Received */}
      <td className="px-3 py-3 text-xs text-slate-500 hidden sm:table-cell nums">
        {formatRelativeTime(row.createdAt)}
      </td>

      {/* Actions */}
      <td className="px-3 py-3 text-right">
        {isNew && (
          <div className="flex items-center justify-end gap-1.5 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onAction(row, 'contacted')}
            >
              <PhoneCall className="h-3 w-3 mr-1" aria-hidden="true" />
              Mark contacted
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-danger hover:text-danger hover:bg-danger/10"
              onClick={() => onAction(row, 'declined')}
            >
              <XCircle className="h-3 w-3 mr-1" aria-hidden="true" />
              Decline
            </Button>
          </div>
        )}
        {isContacted && (
          <div className="flex items-center justify-end gap-1.5 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs text-green-700 border-green-200 hover:bg-green-50"
              onClick={() => onAction(row, 'converted')}
            >
              <CheckCircle2 className="h-3 w-3 mr-1" aria-hidden="true" />
              Mark converted
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-danger hover:text-danger hover:bg-danger/10"
              onClick={() => onAction(row, 'declined')}
            >
              <XCircle className="h-3 w-3 mr-1" aria-hidden="true" />
              Decline
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-slate-600"
              onClick={() => onAction(row, 'contacted')}
            >
              + Note
            </Button>
          </div>
        )}
        {terminal && (
          <span className="text-xs text-slate-400">No actions</span>
        )}
      </td>
    </tr>
  );
}
