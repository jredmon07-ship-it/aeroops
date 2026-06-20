/**
 * check-out-dialog.tsx — "Check out" dialog for opening a dispatch ticket.
 *
 * Renders on a booked reservation block when the user has dispatch:create and
 * the block has no current dispatch ticket (status = none).
 *
 * Fields: Hobbs OUT (step 0.1), Tach OUT (step 0.1), Pilot select (populated
 * via listDispatchPilotsAction on open), optional Notes.
 *
 * Result mapping (Slice 3c additive — existing arms byte-identical):
 *   ok:true                       → close + onSuccess(ticket)
 *   ok:true + eligibilityWarnings → close + onSuccess(ticket) + non-blocking notice
 *   ok:false reason:'already_open' → inline "This aircraft is already checked out"
 *   ok:false reason:'not_found'   → inline "Reservation no longer available"
 *   ok:false reason:'grounded'    → inline "Aircraft is grounded" (blocking)
 *   ok:false reason:'ineligible'  → blocking inline error listing missingTags
 *                                   [VERIFY-3c-A] operator labels, no FAR
 *   ok:false reason:'balance_block' → generic blocking message (reserved/stub)
 *                                   [VERIFY-3c-MONEY] no money concept
 *   { error: 'validation' }       → inline field error
 *   { error: 'forbidden' }        → inline auth error
 *   { error: 'server' }           → generic inline error
 *
 * Cancel button text: "Keep as-is" (autofocused).
 *
 * PILOT LIST: listDispatchPilotsAction is gated on dispatch:access, so every
 * dispatch role (including CFI, who lacks schedule:manage_resources) can load
 * the picker. A free-text userId input remains as a defensive fallback if the
 * list ever fails to load.
 *
 * BOUNDARY: imports only from '@aeroops/api'. No '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { XCircle, AlertTriangle, CheckCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { openDispatchAction, listDispatchPilotsAction } from '../../actions';
import type { DispatchTicketView, DispatchPilotRow } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface CheckOutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The reservation being checked out. */
  reservationId: string;
  /** The aircraft resource being checked out. */
  resourceId: string;
  /** Called on successful check-out — board should reflect the new open state. */
  onSuccess: (ticket: DispatchTicketView) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CheckOutDialog({
  open,
  onOpenChange,
  reservationId,
  resourceId,
  onSuccess,
}: CheckOutDialogProps) {
  // ── Form state ─────────────────────────────────────────────────────────────
  const [hobbsOut, setHobbsOut] = React.useState('');
  const [tachOut, setTachOut] = React.useState('');
  const [pilotUserId, setPilotUserId] = React.useState('');
  const [notes, setNotes] = React.useState('');

  // ── Field-level errors ─────────────────────────────────────────────────────
  const [hobbsError, setHobbsError] = React.useState<string | null>(null);
  const [tachError, setTachError] = React.useState<string | null>(null);
  const [pilotError, setPilotError] = React.useState<string | null>(null);

  // ── Dialog-level error ─────────────────────────────────────────────────────
  const [dialogError, setDialogError] = React.useState<string | null>(null);

  // ── Submission state ───────────────────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // ── Members list for pilot select ──────────────────────────────────────────
  const [members, setMembers] = React.useState<DispatchPilotRow[] | null>(null);
  const [membersLoading, setMembersLoading] = React.useState(false);
  /**
   * membersUnavailable = true when listDispatchPilotsAction returned an error.
   * In this case we fall back to a free-text userId input. (The action is gated
   * on dispatch:access, so every dispatch role — including CFI — can load it.)
   */
  const [membersUnavailable, setMembersUnavailable] = React.useState(false);

  // ── Load members when the dialog opens ─────────────────────────────────────
  React.useEffect(() => {
    if (!open) return;

    // Reset form
    setHobbsOut('');
    setTachOut('');
    setPilotUserId('');
    setNotes('');
    setHobbsError(null);
    setTachError(null);
    setPilotError(null);
    setDialogError(null);
    setMembers(null);
    setMembersUnavailable(false);

    let cancelled = false;
    setMembersLoading(true);

    listDispatchPilotsAction().then((result) => {
      if (cancelled) return;
      setMembersLoading(false);
      if ('ok' in result && result.ok && 'pilots' in result) {
        setMembers(result.pilots);
        // Do NOT auto-select a pilot: pilot-of-record is audited dispatch data;
        // the dispatcher must make a conscious selection to avoid silent
        // mis-attribution of flight records.
      } else {
        // forbidden / server error — fallback to free-text
        setMembersUnavailable(true);
      }
    }).catch(() => {
      if (!cancelled) {
        setMembersLoading(false);
        setMembersUnavailable(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Validation ─────────────────────────────────────────────────────────────
  function validate(): boolean {
    let valid = true;

    const hobbsVal = parseFloat(hobbsOut);
    if (hobbsOut.trim() === '' || isNaN(hobbsVal) || hobbsVal < 0) {
      setHobbsError('Hobbs out must be a non-negative number.');
      valid = false;
    } else {
      setHobbsError(null);
    }

    const tachVal = parseFloat(tachOut);
    if (tachOut.trim() === '' || isNaN(tachVal) || tachVal < 0) {
      setTachError('Tach out must be a non-negative number.');
      valid = false;
    } else {
      setTachError(null);
    }

    if (!pilotUserId.trim()) {
      setPilotError('Pilot is required.');
      valid = false;
    } else {
      setPilotError(null);
    }

    return valid;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);

    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const result = await openDispatchAction({
        reservationId,
        resourceId,
        pilotUserId: pilotUserId.trim(),
        hobbsOut: parseFloat(hobbsOut),
        tachOut: parseFloat(tachOut),
        notes: notes.trim() || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          // Try to map to a field error; fall back to dialog-level
          const msg = result.message.toLowerCase();
          if (msg.includes('hobbs')) {
            setHobbsError(result.message);
          } else if (msg.includes('tach')) {
            setTachError(result.message);
          } else if (msg.includes('pilot') || msg.includes('user')) {
            setPilotError(result.message);
          } else {
            setDialogError(result.message);
          }
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to check out aircraft.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'already_open') {
          setDialogError('This aircraft is already checked out.');
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Reservation no longer available.');
          return;
        }
        if (result.reason === 'grounded') {
          // Blocking error — no write occurred. Show tail # from grounding data if available.
          const reasonText = result.grounding?.reason
            ? `: ${result.grounding.reason}`
            : '';
          setDialogError(
            `This aircraft is grounded and cannot be dispatched${reasonText}. Release it first.`,
          );
          return;
        }
        if (result.reason === 'ineligible') {
          // Pre-flight eligibility gate (Slice 3c) — operator-set free-text required
          // tag(s) the pilot doesn't carry. No write occurred. Operator-data framing
          // (NOT an FAA/currency determination).
          const tags = result.missingTags?.join(', ') ?? '';
          setDialogError(
            `This pilot is missing required tag(s): ${tags}. ` +
              `Add the tag to the pilot, choose a qualified pilot, or remove the requirement.`,
          );
          return;
        }
        if (result.reason === 'balance_block') {
          // Reserved for Phase 2 billing — unreachable with the Phase-1 stub seam.
          setDialogError('Dispatch is blocked by an account-balance hold.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true — dispatch succeeded. In WARN mode the pilot may be missing a
      // required tag (result.eligibilityWarnings); dispatch correctly proceeds
      // regardless. Surfacing that as a non-blocking toast is a tracked polish item.
      onSuccess(result.ticket);
      onOpenChange(false);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check out aircraft</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* ── Hobbs OUT ─────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="co-hobbs-out">
              Hobbs OUT <span aria-hidden="true" className="text-red-500">*</span>
            </Label>
            <Input
              id="co-hobbs-out"
              type="number"
              inputMode="decimal"
              step="0.1"
              min="0"
              placeholder="e.g. 1234.5"
              value={hobbsOut}
              onChange={(e) => setHobbsOut(e.target.value)}
              aria-required="true"
              aria-invalid={hobbsError ? 'true' : undefined}
              aria-describedby={hobbsError ? 'co-hobbs-out-err' : undefined}
              disabled={isSubmitting}
            />
            {hobbsError && (
              <p
                id="co-hobbs-out-err"
                role="alert"
                className="text-xs text-red-600"
              >
                {hobbsError}
              </p>
            )}
          </div>

          {/* ── Tach OUT ──────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="co-tach-out">
              Tach OUT <span aria-hidden="true" className="text-red-500">*</span>
            </Label>
            <Input
              id="co-tach-out"
              type="number"
              inputMode="decimal"
              step="0.1"
              min="0"
              placeholder="e.g. 1234.5"
              value={tachOut}
              onChange={(e) => setTachOut(e.target.value)}
              aria-required="true"
              aria-invalid={tachError ? 'true' : undefined}
              aria-describedby={tachError ? 'co-tach-out-err' : undefined}
              disabled={isSubmitting}
            />
            {tachError && (
              <p
                id="co-tach-out-err"
                role="alert"
                className="text-xs text-red-600"
              >
                {tachError}
              </p>
            )}
          </div>

          {/* ── Pilot ─────────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="co-pilot">
              Pilot <span aria-hidden="true" className="text-red-500">*</span>
            </Label>

            {membersLoading && (
              <div
                className="h-10 w-full rounded-md border border-slate-200 bg-slate-50 animate-pulse"
                aria-busy="true"
                aria-label="Loading pilot list"
              />
            )}

            {/* Member select — shown when members loaded successfully */}
            {!membersLoading && members !== null && !membersUnavailable && (
              <select
                id="co-pilot"
                value={pilotUserId}
                onChange={(e) => setPilotUserId(e.target.value)}
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={pilotError ? 'true' : undefined}
                aria-describedby={pilotError ? 'co-pilot-err' : undefined}
                className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors"
              >
                <option value="">— Select pilot —</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            )}

            {/* Fallback text input — when member list is unavailable */}
            {!membersLoading && membersUnavailable && (
              <Input
                id="co-pilot"
                type="text"
                placeholder="Pilot user ID"
                value={pilotUserId}
                onChange={(e) => setPilotUserId(e.target.value)}
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={pilotError ? 'true' : undefined}
                aria-describedby={
                  pilotError
                    ? 'co-pilot-err'
                    : 'co-pilot-fallback-hint'
                }
              />
            )}
            {membersUnavailable && (
              <p id="co-pilot-fallback-hint" className="text-xs text-slate-500">
                Enter the pilot&apos;s user ID directly.
              </p>
            )}

            {pilotError && (
              <p
                id="co-pilot-err"
                role="alert"
                className="text-xs text-red-600"
              >
                {pilotError}
              </p>
            )}
          </div>

          {/* ── Notes (optional) ──────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="co-notes">Notes (optional)</Label>
            <Input
              id="co-notes"
              type="text"
              placeholder="Optional notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          {/* ── Dialog-level error ────────────────────────────────────────── */}
          {dialogError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            {/* Cancel autofocused per the pattern */}
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                autoFocus
                disabled={isSubmitting}
              >
                Keep as-is
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting || membersLoading}>
              {isSubmitting ? 'Checking out…' : 'Check out'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
