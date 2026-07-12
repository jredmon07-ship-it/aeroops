/**
 * member-expirations-card.tsx — 'Expirations' card on the member detail page
 * (Slice FC-P2 — Confirm-Dispatch parity, migration 0039).
 *
 * Lists the member's operator-entered expiration reminders (soonest first)
 * with a status row per item:
 *   EXPIRED  → red    ('Expired')
 *   <= 30d   → amber  ('Due soon')
 *   ok       → slate
 * plus add (label + date + optional note) and deactivate for people:manage.
 *
 * COMPLIANCE HARD LINE [VERIFY-FC-P2-A] (disclaimer rendered verbatim):
 * "Operator-entered reminder dates. Not a medical/currency/legal
 * determination — verifying actual validity remains the operator's and
 * pilot's responsibility."
 *
 * WARN-ONLY: expirations never block anything — the FROZEN openDispatch gate
 * is untouched by this slice.
 *
 * BOUNDARY: imports only from the people actions ('@aeroops/api' behind them).
 */
'use client';

import * as React from 'react';
import { CalendarClock, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  listMemberExpirationsAction,
  addMemberExpirationAction,
  deactivateMemberExpirationAction,
} from '../actions';
import type { SerializedMemberExpirationView } from '../actions';

// ─── Status chip ───────────────────────────────────────────────────────────────

function ExpirationStatusChip({ status }: { status: SerializedMemberExpirationView['status'] }) {
  if (status === 'expired') {
    return (
      <span className="inline-flex items-center rounded-sm border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-red-800">
        Expired
      </span>
    );
  }
  if (status === 'due_soon') {
    return (
      <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-amber-800">
        Due soon
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
      OK
    </span>
  );
}

// ─── Date-only display (no Date-object timezone drift) ─────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateOnly(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
}

// ─── Row tone per status ────────────────────────────────────────────────────────

const ROW_CLASSES: Record<SerializedMemberExpirationView['status'], string> = {
  expired:  'bg-red-50 border border-red-100',
  due_soon: 'bg-amber-50 border border-amber-100',
  ok:       'bg-slate-50',
};

// ─── Props ─────────────────────────────────────────────────────────────────────

interface MemberExpirationsCardProps {
  memberUserId: string;
  canManage: boolean;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function MemberExpirationsCard({ memberUserId, canManage }: MemberExpirationsCardProps) {
  const [expirations, setExpirations] = React.useState<SerializedMemberExpirationView[] | null>(
    null,
  );
  const [loadError, setLoadError] = React.useState(false);

  // Add form state
  const [label, setLabel] = React.useState('');
  const [expiresOn, setExpiresOn] = React.useState('');
  const [note, setNote] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Per-row deactivate busy state
  const [deactivatingId, setDeactivatingId] = React.useState<string | null>(null);

  // ── Load on mount / member change ───────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    setExpirations(null);
    setLoadError(false);

    listMemberExpirationsAction({ memberUserId })
      .then((result) => {
        if (cancelled) return;
        if ('ok' in result && result.ok) {
          setExpirations(result.expirations);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [memberUserId]);

  // ── Add ─────────────────────────────────────────────────────────────────────
  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setFormError('Label is required (e.g. Medical, Flight review).');
      return;
    }
    if (!expiresOn) {
      setFormError('Expiration date is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await addMemberExpirationAction({
        memberUserId,
        label: trimmedLabel,
        expiresOn,
        note: note.trim() || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setFormError(result.message);
        } else if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setFormError('You do not have permission to add expirations.');
        } else {
          setFormError('Something went wrong. Please try again.');
        }
        return;
      }
      if (!result.ok) {
        setFormError('Member not found.');
        return;
      }

      // Insert in expires_on order (soonest first) to match the server sort.
      setExpirations((prev) => {
        const next = [...(prev ?? []), result.expiration];
        next.sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : 0));
        return next;
      });
      setLabel('');
      setExpiresOn('');
      setNote('');
    } catch {
      setFormError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Deactivate ──────────────────────────────────────────────────────────────
  async function handleDeactivate(expirationId: string) {
    setFormError(null);
    setDeactivatingId(expirationId);
    try {
      const result = await deactivateMemberExpirationAction({ expirationId });
      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setFormError('You do not have permission to remove expirations.');
        } else {
          setFormError('Could not remove the expiration. Please try again.');
        }
        return;
      }
      if (!result.ok) {
        setFormError('Expiration not found — it may already be removed.');
        return;
      }
      // Deactivated rows are hidden (the list shows active reminders only).
      setExpirations((prev) => (prev ?? []).filter((x) => x.id !== expirationId));
    } catch {
      setFormError('Could not remove the expiration. Please try again.');
    } finally {
      setDeactivatingId(null);
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-700">Expirations</h2>
      </div>

      {/* [VERIFY-FC-P2-A] — verbatim disclaimer. */}
      <p className="text-xs text-slate-400">
        Operator-entered reminder dates. Not a medical/currency/legal determination —
        verifying actual validity remains the operator&apos;s and pilot&apos;s
        responsibility.
      </p>

      {/* ── Loading ──────────────────────────────────────────────────────────── */}
      {expirations === null && !loadError && (
        <div
          className="h-16 w-full rounded-md bg-slate-100 animate-pulse"
          aria-busy="true"
          aria-label="Loading expirations"
        />
      )}

      {/* ── Load error ───────────────────────────────────────────────────────── */}
      {loadError && (
        <p className="text-sm text-slate-400 italic">Could not load expirations.</p>
      )}

      {/* ── List ─────────────────────────────────────────────────────────────── */}
      {expirations !== null && !loadError && (
        <>
          {expirations.length === 0 ? (
            <p className="text-sm text-slate-400 italic">
              No expiration reminders on file for this member.
            </p>
          ) : (
            <ul className="space-y-1.5" aria-label="Expiration reminders">
              {expirations.map((exp) => (
                <li
                  key={exp.id}
                  className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 ${ROW_CLASSES[exp.status]}`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-slate-700">{exp.label}</span>
                      <ExpirationStatusChip status={exp.status} />
                    </div>
                    <p className="text-xs text-slate-500">
                      {exp.status === 'expired' ? 'Expired' : 'Expires'}{' '}
                      {formatDateOnly(exp.expiresOn)}
                      {exp.note ? <> — {exp.note}</> : null}
                    </p>
                  </div>
                  {canManage && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeactivate(exp.id)}
                      disabled={deactivatingId !== null}
                      aria-label={`Remove expiration ${exp.label}`}
                    >
                      {deactivatingId === exp.id ? 'Removing…' : 'Remove'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* ── Add form (people:manage) ─────────────────────────────────────── */}
          {canManage && (
            <form onSubmit={handleAdd} className="space-y-2 pt-1" noValidate>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="exp-label">Label</Label>
                  <Input
                    id="exp-label"
                    type="text"
                    placeholder="e.g. Medical, Flight review"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    disabled={isSubmitting}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="exp-date">Expires on</Label>
                  <Input
                    id="exp-date"
                    type="date"
                    value={expiresOn}
                    onChange={(e) => setExpiresOn(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-note">Note (optional)</Label>
                <Input
                  id="exp-note"
                  type="text"
                  placeholder="Optional note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={1000}
                />
              </div>

              {formError && (
                <Alert variant="destructive" role="alert" aria-live="assertive">
                  <XCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? 'Adding…' : 'Add expiration'}
              </Button>
            </form>
          )}

          {/* Deactivate errors for read-only viewers still need a live region. */}
          {!canManage && formError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
