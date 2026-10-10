/**
 * convert-dialog.tsx — Slice PB2.2: "Convert to reservation" dialog.
 *
 * Opened from a "Convert to reservation" row action (calendar-plus icon) on
 * `new` AND `contacted` rows. Rendered only when the session holds BOTH
 * `booking:triage` AND `schedule:create_reservation` (cosmetic guard; the
 * API is the real gate via requireCapability).
 *
 * Dialog flow:
 *   1. Read-only requester context block (name / email / phone).
 *   2. Tail picker (Select of active aircraft from listAircraftAction).
 *   3. Start + end datetime prefilled from the request's requestedStart /
 *      requestedEnd. If requestedEnd is null, endAt = startAt + 1 hour.
 *   4. "Create reservation" primary action.
 *
 * States:
 *   form       — editable tail picker + datetime fields.
 *   submitting — aria-busy, fields + buttons disabled.
 *   success    — dialog closes; parent removes the row from current tab;
 *                counts refresh; a link to the schedule day is provided in
 *                a success notice (shown outside the dialog).
 *   refusal    — dialog stays open, inline per-reason copy (mirrors
 *                new-reservation-form.tsx), explicit "No reservation was created."
 *   not_found  — dialog closes; parent removes the row.
 *   not_convertible — dialog closes; parent refreshes the tab.
 *   forbidden / server — generic inline error.
 *
 * On ok:true with warnings (grounding / twilight / availability warn), the
 * parent receives the warnings and may render a non-blocking notice.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api'. Never '@aeroops/db'.
 * NO money. NO new endpoint.
 *
 * COMPLIANCE [VERIFY-PB2-COMP-1]:
 *   - No price.
 *   - Twilight disclaimer is verbatim (NOT an FAA §61.57 determination).
 *   - Availability disclaimer mirrors the existing form wording.
 */
'use client';

import * as React from 'react';
import { CalendarPlus, AlertCircle, Plane } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { listAircraftAction } from '../../fleet/actions';
import { convertBookingRequestAction } from '../actions';
import type { SerializedBookingRequestRow, SerializedConvertResult } from '../actions';
import type { AircraftListRow, ConflictHit, PolicyViolationView, TwilightHit, AvailabilityHit } from '@aeroops/api';
import {
  defaultEndAt,
  toDatetimeLocal,
  refusalReasonCopy,
} from './convert-dialog-utils';

// Re-export pure helpers so the dialog is the single import point for consumers
// that only need the types (e.g. the parent inbox component).
export { defaultEndAt, toDatetimeLocal, refusalReasonCopy };
export { violationMessage } from './convert-dialog-utils';

// GroundingHit is not barrel-exported from @aeroops/api; use the structural
// inline type that matches the core shape (resourceId + reason).
type GroundingHit = { resourceId: string; reason: string | null };

// ─── RefusalBanner — extracted sub-component to avoid IIFE in JSX ──────────────

interface RefusalState {
  reason: string;
  conflicts?: ConflictHit[];
  violations?: PolicyViolationView[];
  twilight?: TwilightHit[];
}

function RefusalBanner({
  refusal,
  errorRef,
}: {
  refusal: RefusalState;
  errorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const copy = refusalReasonCopy(
    refusal.reason,
    refusal.conflicts,
    refusal.violations,
    refusal.twilight,
  );
  return (
    <Alert
      ref={errorRef}
      variant="destructive"
      role="alert"
      tabIndex={-1}
      aria-live="assertive"
    >
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="space-y-1">
        <p className="font-medium">{copy.headline}</p>
        {copy.detail && (
          <p className="text-sm">{copy.detail}</p>
        )}
        <p className="text-sm font-medium">No reservation was created.</p>
      </AlertDescription>
    </Alert>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ConvertDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The booking request row to convert. */
  row: SerializedBookingRequestRow;
  /** Org slug for revalidatePath + schedule link. */
  slug: string;
  /** Called to close the dialog. */
  onClose: () => void;
  /**
   * Called on ok:true to signal success to the parent.
   * The parent is responsible for removing the row from the list, refreshing
   * counts, and showing the schedule link notice.
   */
  onSuccess: (reservationId: string, reservationStartAt: string, warnings: {
    groundingWarnings?: GroundingHit[];
    twilightWarnings?: TwilightHit[];
    availabilityWarnings?: AvailabilityHit[];
  }) => void;
  /** Called on not_found to signal the row should be removed. */
  onNotFound: () => void;
  /** Called on not_convertible to signal a tab refresh is needed. */
  onNotConvertible: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConvertDialog({
  open,
  row,
  slug,
  onClose,
  onSuccess,
  onNotFound,
  onNotConvertible,
}: ConvertDialogProps) {
  // Aircraft picker
  const [aircraft, setAircraft] = React.useState<AircraftListRow[]>([]);
  const [aircraftLoading, setAircraftLoading] = React.useState(false);
  const [aircraftError, setAircraftError] = React.useState(false);
  const [resourceId, setResourceId] = React.useState('');
  const [resourceIdError, setResourceIdError] = React.useState<string | null>(null);

  // Datetime fields prefilled from the request
  const [startAt, setStartAt] = React.useState('');
  const [endAt, setEndAt] = React.useState('');
  const [startAtError, setStartAtError] = React.useState<string | null>(null);
  const [endAtError, setEndAtError] = React.useState<string | null>(null);

  // Submission state
  const [submitting, setSubmitting] = React.useState(false);

  // Refusal state — shown inline, dialog stays open
  const [refusal, setRefusal] = React.useState<RefusalState | null>(null);

  // Generic error (forbidden / server / validation)
  const [genericError, setGenericError] = React.useState<string | null>(null);

  // Ref for focus management on errors
  const errorRef = React.useRef<HTMLDivElement>(null);

  // Load aircraft when the dialog opens
  React.useEffect(() => {
    if (!open) return;

    // Pre-fill datetime fields from the request row
    const startVal = row.requestedStart
      ? toDatetimeLocal(new Date(row.requestedStart))
      : '';
    setStartAt(startVal);
    setEndAt(defaultEndAt(row.requestedStart, row.requestedEnd));
    setResourceId('');
    setResourceIdError(null);
    setStartAtError(null);
    setEndAtError(null);
    setRefusal(null);
    setGenericError(null);

    // Fetch active aircraft for the tail picker
    setAircraftLoading(true);
    setAircraftError(false);
    listAircraftAction({ includeInactive: false })
      .then((result) => {
        if ('ok' in result && result.ok) {
          setAircraft(result.aircraft.filter((a) => a.active));
        } else {
          setAircraftError(true);
        }
      })
      .catch(() => setAircraftError(true))
      .finally(() => setAircraftLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Client-side validation
  function validate(): boolean {
    let valid = true;
    if (!resourceId) {
      setResourceIdError('Select an aircraft.');
      valid = false;
    }
    if (!startAt) {
      setStartAtError('Start date/time is required.');
      valid = false;
    }
    if (!endAt) {
      setEndAtError('End date/time is required.');
      valid = false;
    } else if (startAt && endAt) {
      const s = new Date(startAt);
      const e = new Date(endAt);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e <= s) {
        setEndAtError('End must be after start.');
        valid = false;
      }
    }
    return valid;
  }

  async function handleSubmit() {
    setRefusal(null);
    setGenericError(null);
    setResourceIdError(null);
    setStartAtError(null);
    setEndAtError(null);

    if (!validate()) return;

    setSubmitting(true);
    try {
      const result: SerializedConvertResult = await convertBookingRequestAction(
        {
          id: row.id,
          resourceId,
          startAt,
          endAt,
        },
        slug,
      );

      if ('error' in result) {
        // Auth/validation/server error
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setGenericError('You do not have permission to convert booking requests.');
        } else if (result.error === 'validation') {
          setGenericError(`Invalid input: ${result.message}`);
        } else {
          setGenericError('Something went wrong. Please try again.');
        }
        errorRef.current?.focus();
        return;
      }

      if (!result.ok) {
        // Operational refusals
        if (result.reason === 'not_found') {
          onNotFound();
          onClose();
          return;
        }
        if (result.reason === 'not_convertible') {
          onNotConvertible();
          onClose();
          return;
        }
        // Gate refusals — show inline, dialog stays open
        setRefusal({
          reason: result.reason,
          conflicts: 'conflicts' in result ? result.conflicts : undefined,
          violations: 'violations' in result ? result.violations : undefined,
          twilight: 'twilight' in result ? result.twilight : undefined,
        });
        errorRef.current?.focus();
        return;
      }

      // Success
      onSuccess(result.reservationId, result.reservation.startAt, {
        groundingWarnings: result.groundingWarnings,
        twilightWarnings: result.twilightWarnings,
        availabilityWarnings: result.availabilityWarnings,
      });
      onClose();
    } catch {
      setGenericError('Something went wrong. Please try again.');
      errorRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  // Build the schedule day link from the reservation's startAt ISO string.
  // Used in the onSuccess callback above — the parent receives the startAt.

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !submitting) onClose();
      }}
    >
      <DialogContent aria-describedby="convert-dialog-desc">
        <DialogHeader>
          <DialogTitle>Convert to reservation</DialogTitle>
          <DialogDescription id="convert-dialog-desc">
            Create a real reservation from this booking request. Pick an aircraft
            and confirm the date/time.
          </DialogDescription>
        </DialogHeader>

        {/* ── Requester context block (read-only) ─────────────────────────── */}
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-4 py-3 space-y-0.5">
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide mb-1">
            Booking for
          </p>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{row.requesterName}</p>
          <a
            href={`mailto:${row.requesterEmail}`}
            className="text-sm text-brand hover:underline underline-offset-2 block"
          >
            {row.requesterEmail}
          </a>
          {row.requesterPhone && (
            <p className="text-sm text-slate-600 dark:text-slate-300 nums">{row.requesterPhone}</p>
          )}
        </div>

        {/* ── Generic error ───────────────────────────────────────────────── */}
        {genericError && (
          <Alert
            ref={errorRef}
            variant="destructive"
            role="alert"
            tabIndex={-1}
          >
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{genericError}</AlertDescription>
          </Alert>
        )}

        {/* ── Refusal banner ───────────────────────────────────────────────
             Dialog stays open on gate refusal. Each refusal says
             "No reservation was created." Per spec PB2.2.                  */}
        {refusal && (
          <RefusalBanner
            refusal={refusal}
            errorRef={errorRef}
          />
        )}

        {/* ── Aircraft tail picker ────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <Label htmlFor="convert-aircraft">
            Aircraft <span aria-hidden="true">*</span>
          </Label>
          {aircraftLoading && (
            <div className="h-10 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 animate-pulse" />
          )}
          {!aircraftLoading && aircraftError && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              Could not load aircraft. Try closing and reopening the dialog.
            </p>
          )}
          {!aircraftLoading && !aircraftError && (
            <select
              id="convert-aircraft"
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                setResourceIdError(null);
                setRefusal(null);
              }}
              disabled={submitting}
              aria-required="true"
              aria-describedby={resourceIdError ? 'convert-aircraft-error' : undefined}
              className={[
                'flex h-10 w-full rounded-md border bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100',
                'hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand',
                'focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0',
                'disabled:cursor-not-allowed disabled:opacity-50 transition-colors',
                resourceIdError ? 'border-red-500' : 'border-slate-300 dark:border-slate-700',
              ].join(' ')}
            >
              <option value="">— Select aircraft —</option>
              {aircraft.map((a) => {
                const label = a.tailNumber
                  ? `${a.tailNumber}${a.make || a.model ? ` — ${[a.make, a.model].filter(Boolean).join(' ')}` : ''}`
                  : a.tailNumber;
                return (
                  <option key={a.id} value={a.id} disabled={a.grounded}>
                    {a.grounded ? `[Grounded] ${label}` : label}
                  </option>
                );
              })}
              {aircraft.length === 0 && (
                <option disabled>No active aircraft found</option>
              )}
            </select>
          )}
          {resourceIdError && (
            <p id="convert-aircraft-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
              {resourceIdError}
            </p>
          )}
        </div>

        {/* ── Start datetime ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="convert-start">
              Start <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="convert-start"
              type="datetime-local"
              value={startAt}
              onChange={(e) => {
                setStartAt(e.target.value);
                setStartAtError(null);
                setRefusal(null);
              }}
              disabled={submitting}
              required
              aria-required="true"
              aria-describedby={startAtError ? 'convert-start-error' : undefined}
              className={startAtError ? 'border-red-500' : ''}
            />
            {startAtError && (
              <p id="convert-start-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
                {startAtError}
              </p>
            )}
          </div>

          {/* ── End datetime ─────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="convert-end">
              End <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="convert-end"
              type="datetime-local"
              value={endAt}
              onChange={(e) => {
                setEndAt(e.target.value);
                setEndAtError(null);
                setRefusal(null);
              }}
              disabled={submitting}
              required
              aria-required="true"
              aria-describedby={endAtError ? 'convert-end-error' : undefined}
              className={endAtError ? 'border-red-500' : ''}
            />
            {endAtError && (
              <p id="convert-end-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
                {endAtError}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => { void handleSubmit(); }}
            disabled={submitting || aircraftLoading}
            aria-busy={submitting}
          >
            <Plane className="h-4 w-4 mr-1.5" aria-hidden="true" />
            {submitting ? 'Creating reservation…' : 'Create reservation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Convert action button ────────────────────────────────────────────────────

/**
 * ConvertActionButton — the calendar-plus row action shown on new/contacted rows.
 * Cosmetically gated on BOTH booking:triage AND schedule:create_reservation;
 * the API enforces both caps.
 */
export interface ConvertActionButtonProps {
  onClick: () => void;
  /** Disabled while another dialog is submitting. */
  disabled?: boolean;
  /**
   * The requester's name — included in the accessible label so screen-reader
   * users scanning a multi-row table hear "Convert to reservation — Alice Smith"
   * rather than repeated identical "Convert to reservation" labels.
   */
  requesterName?: string;
}

export function ConvertActionButton({ onClick, disabled, requesterName }: ConvertActionButtonProps) {
  const label = requesterName
    ? `Convert to reservation — ${requesterName}`
    : 'Convert to reservation';
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <CalendarPlus className="h-3 w-3 mr-1" aria-hidden="true" />
      Convert
    </Button>
  );
}
