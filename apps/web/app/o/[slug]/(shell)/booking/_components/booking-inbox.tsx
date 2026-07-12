/**
 * booking-inbox.tsx — Client component for the booking-request triage inbox.
 *
 * States: loading (skeleton at page level) / empty / populated / error.
 *
 * Primary action per status:
 *   new       → "Convert to reservation" (primary) + "Mark contacted" + "Decline"
 *   contacted → "Convert to reservation" (primary) + "Decline" + re-note option
 *   converted → read-only + "View reservation" link from convertedReservationId
 *   declined  → read-only
 *
 * PB2.2: "Mark converted" (flag-only) is REMOVED — the only path to 'converted'
 * is now `convertBookingRequest` via the ConvertDialog. The ConvertDialog is shown
 * on new AND contacted rows, rendered only when the session has BOTH
 * `booking:triage` AND `schedule:create_reservation` (cosmetic; API is the gate).
 *
 * Status tabs show the four per-status counts from the API.
 * Each non-convert action optionally collects a triageNotes via an inline note field.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 * Dates are pre-serialized to ISO strings at the action boundary.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Inbox, AlertCircle, PhoneCall, XCircle, CalendarDays } from 'lucide-react';
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
import { ConvertDialog, ConvertActionButton } from './convert-dialog';
import { formatRelativeTime } from '@/lib/activity-utils';
import {
  listBookingRequestsAction,
  updateBookingRequestStatusAction,
} from '../actions';
import type { SerializedBookingRequestRow, SerializedListBookingRequestsResult } from '../actions';
import type { TwilightHit, AvailabilityHit } from '@aeroops/api';

// GroundingHit is not barrel-exported from @aeroops/api; use the structural
// inline type that matches the core shape.
type GroundingHit = { resourceId: string; reason: string | null };

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveStatus = 'new' | 'contacted' | 'converted' | 'declined';

interface BookingInboxProps {
  /** Initial data from the RSC (status='new'). */
  initial: SerializedListBookingRequestsResult;
  slug: string;
  /**
   * PB2.2 cosmetic gate: whether the session has BOTH booking:triage AND
   * schedule:create_reservation. The API is the real gate; this controls
   * whether the "Convert to reservation" button renders.
   *
   * Defaults to false (safe); the page passes this from hasCapability checks.
   * The gate is cosmetic only — a user who lacks the cap and somehow clicks
   * the button will receive a Forbidden from the server action.
   */
  canConvert?: boolean;
}

// ─── Status tab config ────────────────────────────────────────────────────────

const STATUS_TABS: { value: ActiveStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'converted', label: 'Converted' },
  { value: 'declined', label: 'Declined' },
];

// ─── Action dialog (triage status transitions) ─────────────────────────────────

interface ActionDialogState {
  open: boolean;
  requestId: string;
  requestName: string;
  newStatus: 'contacted' | 'declined';
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

// ─── Convert success notice ────────────────────────────────────────────────────

interface ConvertSuccessNotice {
  reservationId: string;
  reservationStartAt: string;
  warnings: {
    groundingWarnings?: GroundingHit[];
    twilightWarnings?: TwilightHit[];
    availabilityWarnings?: AvailabilityHit[];
  };
}

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

// ─── Convert success banner ───────────────────────────────────────────────────

function ConvertSuccessBanner({
  notice,
  slug,
  onDismiss,
}: {
  notice: ConvertSuccessNotice;
  slug: string;
  onDismiss: () => void;
}) {
  // Build the schedule day link from the reservation's startAt.
  const scheduleDayLink = React.useMemo(() => {
    try {
      const d = new Date(notice.reservationStartAt);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `/o/${slug}/schedule?date=${yyyy}-${mm}-${dd}`;
      }
    } catch { /* ignore */ }
    return `/o/${slug}/schedule`;
  }, [notice.reservationStartAt, slug]);

  const hasWarnings =
    (notice.warnings.groundingWarnings?.length ?? 0) > 0 ||
    (notice.warnings.twilightWarnings?.length ?? 0) > 0 ||
    (notice.warnings.availabilityWarnings?.length ?? 0) > 0;

  return (
    <Alert className="border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40" role="status" aria-live="polite">
      <AlertDescription className="space-y-2">
        <p className="font-medium text-green-900 dark:text-green-200">
          Reservation created. The request has been marked as converted.
        </p>
        {hasWarnings && (
          <ul className="list-disc list-inside text-sm text-amber-800 dark:text-amber-200 space-y-0.5">
            {(notice.warnings.groundingWarnings ?? []).map((w, i) => (
              <li key={`grounding-${i}`}>
                Aircraft is grounded{w.reason ? `: ${w.reason}` : ''}. Dispatch will be blocked until released.
              </li>
            ))}
            {(notice.warnings.twilightWarnings ?? []).map((w, i) => {
              const time = new Intl.DateTimeFormat(undefined, {
                hour: '2-digit', minute: '2-digit', hour12: false,
              }).format(new Date(w.boundaryUtcMs));
              const copy =
                w.reason === 'ends_after_civil_dusk'
                  ? `Note: reservation ends after civil dusk (${time}).`
                  : `Note: reservation starts before civil dawn (${time}).`;
              return <li key={`twilight-${i}`}>{copy}</li>;
            })}
            {(notice.warnings.availabilityWarnings ?? []).map((_w, i) => (
              <li key={`avail-${i}`}>
                Note: reservation falls partly outside the aircraft&apos;s operating hours.
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3 pt-1">
          <Link
            href={scheduleDayLink}
            className="inline-flex items-center gap-1 text-sm text-green-800 dark:text-green-200 underline underline-offset-2 hover:text-green-900 dark:hover:text-green-200"
          >
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            View on schedule
          </Link>
          <button
            type="button"
            onClick={onDismiss}
            className="text-sm text-green-700 dark:text-green-300 hover:text-green-900 dark:hover:text-green-200"
          >
            Dismiss
          </button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BookingInbox({ initial, slug, canConvert = false }: BookingInboxProps) {
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

  // Action dialog (for Mark contacted / Decline transitions)
  const [dialog, setDialog] = React.useState<ActionDialogState>(CLOSED_DIALOG);
  const [triageNotes, setTriageNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [inlineError, setInlineError] = React.useState<
    'not_found' | 'invalid_transition' | 'other' | null
  >(null);

  // Convert dialog (PB2.2)
  const [convertRow, setConvertRow] = React.useState<SerializedBookingRequestRow | null>(null);
  const [convertSuccessNotice, setConvertSuccessNotice] = React.useState<ConvertSuccessNotice | null>(null);

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

  // ── Open action dialog (triage status changes) ─────────────────────────────

  function openDialog(
    row: SerializedBookingRequestRow,
    newStatus: 'contacted' | 'declined',
  ) {
    setTriageNotes('');
    setInlineError(null);
    setConvertSuccessNotice(null);
    setDialog({
      open: true,
      requestId: row.id,
      requestName: row.requesterName,
      newStatus,
      isDecline: newStatus === 'declined',
    });
  }

  // ── Open convert dialog (PB2.2) ─────────────────────────────────────────────

  function openConvertDialog(row: SerializedBookingRequestRow) {
    setConvertSuccessNotice(null);
    setInlineError(null);
    setConvertRow(row);
  }

  function handleConvertSuccess(
    reservationId: string,
    reservationStartAt: string,
    warnings: {
      groundingWarnings?: GroundingHit[];
      twilightWarnings?: TwilightHit[];
      availabilityWarnings?: AvailabilityHit[];
    },
  ) {
    // Remove the converted row from the current tab (it moved to Converted)
    setRows((prev) => prev.filter((r) => r.id !== convertRow?.id));
    setConvertRow(null);
    // Show success notice with schedule link
    setConvertSuccessNotice({ reservationId, reservationStartAt, warnings });
    // Refresh counts
    listBookingRequestsAction({ status: activeStatus })
      .then((r) => { if (!('error' in r)) setCounts(r.counts); })
      .catch(() => { /* best-effort */ });
  }

  function handleConvertNotFound() {
    setRows((prev) => prev.filter((r) => r.id !== convertRow?.id));
    setConvertRow(null);
    setInlineError('not_found');
  }

  function handleConvertNotConvertible() {
    setConvertRow(null);
    // Re-fetch to pick up the latest status
    listBookingRequestsAction({ status: activeStatus })
      .then((r) => {
        if (!('error' in r)) {
          setRows(r.rows);
          setCounts(r.counts);
        }
      })
      .catch(() => { /* best-effort */ });
  }

  // ── Submit action (triage status change) ────────────────────────────────────

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
    return 'Decline request';
  }

  function dialogDescription(): string {
    if (dialog.newStatus === 'contacted')
      return `Record that you've contacted ${dialog.requestName}. Add an optional note.`;
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

      {/* ── Convert success notice ─────────────────────────────────────────── */}
      {convertSuccessNotice && (
        <ConvertSuccessBanner
          notice={convertSuccessNotice}
          slug={slug}
          onDismiss={() => setConvertSuccessNotice(null)}
        />
      )}

      {/* ── Status tabs ────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Filter by status"
        className="flex flex-wrap gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 p-1"
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
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs border border-slate-200 dark:border-slate-800'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-white/60',
              ].join(' ')}
            >
              {tab.label}
              {count > 0 && (
                <span
                  className={[
                    'inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[0.6875rem] font-bold leading-none nums',
                    isActive
                      ? 'bg-brand text-white'
                      : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
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
      {/* tabIndex={0}: ARIA spec requires tabpanel to be keyboard-focusable so
          keyboard users can Tab into the panel from the tablist. */}
      <div
        role="tabpanel"
        id={`booking-panel-${activeStatus}`}
        aria-labelledby={`booking-tab-${activeStatus}`}
        tabIndex={0}
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
                className="h-16 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800"
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
            <p className="text-slate-500 dark:text-slate-400 font-medium">
              {emptyLabel[activeStatus]}
            </p>
            {activeStatus !== 'new' && (
              <p className="text-sm text-slate-400 dark:text-slate-500">
                Switch to the{' '}
                <button
                  type="button"
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
          <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
            <table className="w-full text-sm" aria-label={`${activeStatus} booking requests`}>
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide"
                  >
                    Requester
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell"
                  >
                    Requested date
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden md:table-cell"
                  >
                    Aircraft pref
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell"
                  >
                    Received
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide"
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
                    slug={slug}
                    canConvert={canConvert}
                    onAction={openDialog}
                    onConvert={openConvertDialog}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Action dialog ─────────────────────────────────────────────────────
           Decline is destructive → confirm step with explicit warning copy.
           Mark contacted → note field + submit.
           Note: "Mark converted" (flag-only) is REMOVED in PB2.2 — use the
           Convert dialog instead (convertBookingRequest is the only path to
           status='converted').
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
            <Label htmlFor="triage-notes" className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Note{' '}
              <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
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

      {/* ── Convert dialog (PB2.2) ────────────────────────────────────────────
           Shown on new + contacted rows when canConvert=true.
           Closes on success / not_found / not_convertible; stays open on
           gate refusals (conflict / policy / twilight / availability).
      ──────────────────────────────────────────────────────────────────────── */}
      {convertRow && (
        <ConvertDialog
          open={!!convertRow}
          row={convertRow}
          slug={slug}
          onClose={() => setConvertRow(null)}
          onSuccess={handleConvertSuccess}
          onNotFound={handleConvertNotFound}
          onNotConvertible={handleConvertNotConvertible}
        />
      )}
    </div>
  );
}

// ─── BookingRow ───────────────────────────────────────────────────────────────

interface BookingRowProps {
  row: SerializedBookingRequestRow;
  slug: string;
  /** Cosmetic gate: whether the session holds BOTH booking:triage + schedule:create_reservation. */
  canConvert: boolean;
  onAction: (
    row: SerializedBookingRequestRow,
    newStatus: 'contacted' | 'declined',
  ) => void;
  /** Opens the ConvertDialog for this row. */
  onConvert: (row: SerializedBookingRequestRow) => void;
}

function BookingRow({ row, slug, canConvert, onAction, onConvert }: BookingRowProps) {
  const terminal = isTerminalStatus(row.status);
  const isNew = row.status === 'new';
  const isContacted = row.status === 'contacted';
  const isConverted = row.status === 'converted';

  // Build "View reservation" link for Converted rows.
  const viewReservationHref = React.useMemo(() => {
    if (!isConverted || !row.convertedReservationId) return null;
    // Link to the schedule board day of the reservation — we don't know the date here,
    // so link to the general schedule page. The actual date can be determined server-side
    // in a future enhancement. For now link to /schedule with the reservation surfaced.
    // Per spec: "link to the schedule board day of the new reservation".
    // We use the requestedStart as a proxy date for the schedule link.
    if (row.requestedStart) {
      try {
        const d = new Date(row.requestedStart);
        if (!isNaN(d.getTime())) {
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          return `/o/${slug}/schedule?date=${yyyy}-${mm}-${dd}`;
        }
      } catch { /* ignore */ }
    }
    return `/o/${slug}/schedule`;
  }, [isConverted, row.convertedReservationId, row.requestedStart, slug]);

  return (
    <tr className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
      {/* Requester */}
      <td className="px-3 py-3">
        <p className="font-medium text-slate-900 dark:text-slate-100 truncate max-w-[160px]">
          {row.requesterName}
        </p>
        <a
          href={`mailto:${row.requesterEmail}`}
          className="text-xs text-brand hover:underline underline-offset-2 truncate block max-w-[160px]"
        >
          {row.requesterEmail}
        </a>
        {row.requesterPhone && (
          <p className="text-xs text-slate-500 dark:text-slate-400 nums">{row.requesterPhone}</p>
        )}
        {row.message && (
          <p className="text-xs text-slate-400 dark:text-slate-500 truncate max-w-[200px] mt-0.5 italic">
            &ldquo;{row.message}&rdquo;
          </p>
        )}
      </td>

      {/* Requested date */}
      <td className="px-3 py-3 hidden sm:table-cell text-xs text-slate-600 dark:text-slate-300 nums">
        {formatRequestedDate(row.requestedStart, row.requestedEnd)}
      </td>

      {/* Aircraft pref */}
      <td className="px-3 py-3 hidden md:table-cell">
        {row.aircraftTypePref ? (
          <span className="text-xs text-slate-700 dark:text-slate-300">{row.aircraftTypePref}</span>
        ) : (
          <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-3 py-3">
        <BookingStatusBadge status={row.status} />
        {terminal && row.handledAt && (
          <p className="text-[0.6875rem] text-slate-400 dark:text-slate-500 mt-0.5 nums">
            {formatRelativeTime(row.handledAt)}
          </p>
        )}
        {row.triageNotes && (
          <p className="text-[0.6875rem] text-slate-500 dark:text-slate-400 mt-0.5 truncate max-w-[120px] italic">
            {row.triageNotes}
          </p>
        )}
      </td>

      {/* Received */}
      <td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400 hidden sm:table-cell nums">
        {formatRelativeTime(row.createdAt)}
      </td>

      {/* Actions */}
      <td className="px-3 py-3 text-right">
        {isNew && (
          <div className="flex items-center justify-end gap-1.5 flex-wrap">
            {/* Primary: Convert to reservation (PB2.2) */}
            {canConvert && (
              <ConvertActionButton onClick={() => onConvert(row)} requesterName={row.requesterName} />
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onAction(row, 'contacted')}
              aria-label={`Mark contacted — ${row.requesterName}`}
            >
              <PhoneCall className="h-3 w-3 mr-1" aria-hidden="true" />
              Mark contacted
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-danger hover:text-danger hover:bg-danger/10"
              onClick={() => onAction(row, 'declined')}
              aria-label={`Decline request from ${row.requesterName}`}
            >
              <XCircle className="h-3 w-3 mr-1" aria-hidden="true" />
              Decline
            </Button>
          </div>
        )}
        {isContacted && (
          <div className="flex items-center justify-end gap-1.5 flex-wrap">
            {/* Primary: Convert to reservation (PB2.2).
                "Mark converted" (flag-only) is REMOVED per PB2.2 spec. */}
            {canConvert && (
              <ConvertActionButton onClick={() => onConvert(row)} requesterName={row.requesterName} />
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-danger hover:text-danger hover:bg-danger/10"
              onClick={() => onAction(row, 'declined')}
              aria-label={`Decline request from ${row.requesterName}`}
            >
              <XCircle className="h-3 w-3 mr-1" aria-hidden="true" />
              Decline
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-slate-600 dark:text-slate-300"
              onClick={() => onAction(row, 'contacted')}
              aria-label={`Add note for ${row.requesterName}`}
            >
              + Note
            </Button>
          </div>
        )}
        {isConverted && (
          <div className="flex items-center justify-end gap-1.5">
            {viewReservationHref ? (
              <Link
                href={viewReservationHref}
                className="inline-flex items-center gap-1 text-xs text-brand hover:underline underline-offset-2"
              >
                <CalendarDays className="h-3 w-3" aria-hidden="true" />
                View reservation
              </Link>
            ) : (
              <span className="text-xs text-slate-400 dark:text-slate-500">Converted</span>
            )}
          </div>
        )}
        {row.status === 'declined' && (
          <span className="text-xs text-slate-400 dark:text-slate-500">No actions</span>
        )}
      </td>
    </tr>
  );
}
