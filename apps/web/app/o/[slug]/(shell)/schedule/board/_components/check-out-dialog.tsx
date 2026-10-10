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
 * PRE-FLIGHT CHECKLIST (Slice FC-P2 — Confirm-Dispatch parity, ADDITIVE):
 * once a pilot is selected, getDispatchPreflightAction renders READ-ONLY
 * status rows (grounding / open squawks / pilot expirations) BEFORE the
 * Dispatch button. WARN-ONLY — these rows
 * never block; the actual openDispatch call and its gate handling below are
 * byte-identical to before this slice. [VERIFY-FC-P2-A]: expirations are
 * operator-entered reminder dates, NOT a medical/currency/legal determination.
 *
 * A local "Pilot briefed" checkbox must be ticked to enable the Dispatch
 * button — a UI-only affordance, clearly NOT recorded anywhere (no schema,
 * no write).
 *
 * BOUNDARY: imports only from '@aeroops/api'. No '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { XCircle } from 'lucide-react';
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
import {
  openDispatchAction,
  listDispatchPilotsAction,
  getDispatchPreflightAction,
} from '../../actions';
import type { DispatchPreflight } from '../../actions';
import type { DispatchTicketView, DispatchPilotRow } from '@aeroops/api';
import { toast } from '@/lib/toast-store';

// ─── Pre-flight helpers (Slice FC-P2) ─────────────────────────────────────────

/** Full-UUID guard for the pre-flight fetch (pilot ids are always UUIDs). */
const PILOT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Pre-flight status chips (Slice FC-P2) ────────────────────────────────────

type PreflightTone = 'ok' | 'warn' | 'bad' | 'muted';

const PREFLIGHT_CHIP_CLASSES: Record<PreflightTone, string> = {
  ok:    'border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-200',
  warn:  'border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
  bad:   'border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200',
  muted: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
};

function PreflightChip({ tone, children }: { tone: PreflightTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 ${PREFLIGHT_CHIP_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

function PreflightRow({
  label,
  chip,
  detail,
}: {
  label: string;
  chip: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-600 dark:text-slate-300">{label}</span>
        {chip}
      </div>
      {detail}
    </div>
  );
}

function formatDateOnly(iso: string): string {
  // 'YYYY-MM-DD' rendered without Date-object timezone drift.
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
}

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

  // ── Pre-flight checklist state (Slice FC-P2 — read-only, warn-only) ────────
  const [preflight, setPreflight] = React.useState<DispatchPreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = React.useState(false);
  /**
   * Local, NON-PERSISTED confirmation checkbox — a UI-only affordance gating
   * the Dispatch button. Never sent to the server, never recorded.
   */
  const [briefed, setBriefed] = React.useState(false);

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
    setPreflight(null);
    setPreflightLoading(false);
    setBriefed(false);

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

  // ── Reset the "briefed" confirmation whenever the pilot changes ────────────
  // "Pilot briefed" attests to THIS pilot's W&B/NOTAMs/weather. Switching the
  // pilot dropdown (dialog stays open) must clear it so a stale confirmation
  // from pilot A can't leave Dispatch enabled for pilot B. (The open-effect
  // above resets it on first open — pilotUserId is '' there → this also fires.)
  React.useEffect(() => {
    setBriefed(false);
  }, [pilotUserId]);

  // ── Load the pre-flight checklist when a pilot is selected ─────────────────
  // Read-only, warn-only status snapshot (grounding / squawks / expirations).
  // Failures degrade to hidden rows — never block the form.
  // Only fires for a full UUID (select values always are; the free-text
  // fallback fires once the pasted/typed id is complete — not per keystroke).
  React.useEffect(() => {
    if (!open) return;
    const pilot = pilotUserId.trim();
    if (!pilot || !PILOT_UUID_RE.test(pilot)) {
      setPreflight(null);
      return;
    }

    let cancelled = false;
    setPreflightLoading(true);

    getDispatchPreflightAction({ resourceId, pilotUserId: pilot })
      .then((result) => {
        if (cancelled) return;
        setPreflightLoading(false);
        if ('ok' in result && result.ok) {
          setPreflight(result.preflight);
        } else {
          setPreflight(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreflightLoading(false);
          setPreflight(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, resourceId, pilotUserId]);

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
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true — dispatch succeeded. In WARN mode the pilot may be missing a
      // required tag (result.eligibilityWarnings); dispatch correctly proceeds
      // regardless — surfaced as a non-blocking warning toast.
      toast.success('Aircraft checked out — dispatch ticket open.');
      if (result.eligibilityWarnings && result.eligibilityWarnings.length > 0) {
        toast.warning(result.eligibilityWarnings.join(' '));
      }
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
              Hobbs OUT <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
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
                className="text-xs text-red-600 dark:text-red-400"
              >
                {hobbsError}
              </p>
            )}
          </div>

          {/* ── Tach OUT ──────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="co-tach-out">
              Tach OUT <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
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
                className="text-xs text-red-600 dark:text-red-400"
              >
                {tachError}
              </p>
            )}
          </div>

          {/* ── Pilot ─────────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="co-pilot">
              Pilot <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
            </Label>

            {membersLoading && (
              <div
                className="h-10 w-full rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 animate-pulse"
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
                className="flex h-10 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors"
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
              <p id="co-pilot-fallback-hint" className="text-xs text-slate-500 dark:text-slate-400">
                Enter the pilot&apos;s user ID directly.
              </p>
            )}

            {pilotError && (
              <p
                id="co-pilot-err"
                role="alert"
                className="text-xs text-red-600 dark:text-red-400"
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

          {/* ── Pre-flight checklist (Slice FC-P2 — read-only, warn-only) ── */}
          {/* Never blocks: the FROZEN openDispatch gate still runs on submit. */}
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/60 p-3 space-y-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Confirm dispatch — pre-flight check
            </h3>

            {!PILOT_UUID_RE.test(pilotUserId.trim()) && (
              <p className="text-xs text-slate-400 dark:text-slate-500 italic">
                Select a pilot to run the pre-flight check.
              </p>
            )}

            {PILOT_UUID_RE.test(pilotUserId.trim()) && preflightLoading && (
              <div
                className="h-16 w-full rounded-md bg-slate-100 dark:bg-slate-800 animate-pulse"
                aria-busy="true"
                aria-label="Loading pre-flight check"
              />
            )}

            {PILOT_UUID_RE.test(pilotUserId.trim()) && !preflightLoading && preflight === null && (
              <p className="text-xs text-slate-400 dark:text-slate-500 italic">
                Pre-flight status unavailable. You can still dispatch — the
                dispatch gate runs on submit.
              </p>
            )}

            {PILOT_UUID_RE.test(pilotUserId.trim()) && !preflightLoading && preflight !== null && (
              <div className="space-y-2.5">
                {/* Aircraft grounding — reuses the existing grounding read. */}
                {preflight.grounding !== null && (
                  <PreflightRow
                    label="Aircraft grounding"
                    chip={
                      preflight.grounding.grounded ? (
                        <PreflightChip tone="bad">Grounded</PreflightChip>
                      ) : (
                        <PreflightChip tone="ok">Not grounded</PreflightChip>
                      )
                    }
                    detail={
                      preflight.grounding.grounded && preflight.grounding.reason ? (
                        <p className="text-xs text-red-700 dark:text-red-300">{preflight.grounding.reason}</p>
                      ) : undefined
                    }
                  />
                )}

                {/* Open squawks — advisory count. */}
                {preflight.openSquawkCount !== null && (
                  <PreflightRow
                    label="Open squawks"
                    chip={
                      preflight.openSquawkCount > 0 ? (
                        <PreflightChip tone="warn">
                          {preflight.openSquawkCount} open
                        </PreflightChip>
                      ) : (
                        <PreflightChip tone="ok">None</PreflightChip>
                      )
                    }
                  />
                )}

                {/* Pilot expirations — operator-entered reminder dates. */}
                {preflight.expirations !== null && (
                  <PreflightRow
                    label="Pilot expirations"
                    chip={
                      preflight.expirations.expiredCount > 0 ? (
                        <PreflightChip tone="bad">Expired</PreflightChip>
                      ) : preflight.expirations.dueSoonCount > 0 ? (
                        <PreflightChip tone="warn">Due soon</PreflightChip>
                      ) : (
                        <PreflightChip tone="ok">None due</PreflightChip>
                      )
                    }
                    detail={
                      <>
                        {preflight.expirations.items
                          .filter((e) => e.status !== 'ok')
                          .map((e) => (
                            <p
                              key={e.id}
                              className={`text-xs ${
                                e.status === 'expired' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'
                              }`}
                            >
                              {e.label} — {e.status === 'expired' ? 'expired' : 'due'}{' '}
                              {formatDateOnly(e.expiresOn)}
                            </p>
                          ))}
                        {/* [VERIFY-FC-P2-A] — verbatim disclaimer. */}
                        <p className="text-[0.6875rem] leading-4 text-slate-400 dark:text-slate-500">
                          Operator-entered reminder dates. Not a medical/currency/legal
                          determination — verifying actual validity remains the
                          operator&apos;s and pilot&apos;s responsibility.
                        </p>
                      </>
                    }
                  />
                )}
              </div>
            )}

            {/* Local confirmation — UI-only affordance, clearly NOT recorded. */}
            <label className="flex items-start gap-2 pt-1 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={briefed}
                onChange={(e) => setBriefed(e.target.checked)}
                disabled={isSubmitting}
                className="mt-0.5 h-4 w-4 accent-brand"
                aria-describedby="co-briefed-hint"
              />
              <span>
                Pilot briefed: W&amp;B, NOTAMs, weather verified{' '}
                <span id="co-briefed-hint" className="text-xs text-slate-400 dark:text-slate-500">
                  (confirmation to enable Dispatch — not recorded)
                </span>
              </span>
            </label>
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
            {/* Disabled until "Pilot briefed" is ticked (UI-only affordance —
                the server-side dispatch gate is unchanged). */}
            <Button type="submit" disabled={isSubmitting || membersLoading || !briefed}>
              {isSubmitting ? 'Checking out…' : 'Check out'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
