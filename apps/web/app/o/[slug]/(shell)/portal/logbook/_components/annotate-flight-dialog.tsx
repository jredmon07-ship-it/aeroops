/**
 * annotate-flight-dialog.tsx — per-row "Annotate" dialog for the pilot
 * logbook (Slice P2-LOG2). Used by BOTH the portal my-logbook page and the
 * staff People member-logbook card (the underlying server action enforces
 * self-vs-staff scoping — see annotateFlightAction in portal/actions.ts).
 *
 * Fields: night / instrument (IMC) / cross-country hours (tenths, 0–99.9)
 * + free-text remarks. Pre-filled from the row's current effective
 * annotation; saving APPENDS a new annotation row (latest wins) — it never
 * edits history.
 *
 * COMPLIANCE HARD LINE: pilot/operator-entered data — NOT an FAA logbook of
 * record, NOT a certified §61.51 entry; AeroOps does not compute currency.
 *
 * States: idle / submitting (inputs disabled, "Saving…") / inline field
 * validation / dialog-level error (assertive alert) / success (close +
 * router.refresh()).
 *
 * BOUNDARY: imports only the server action. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { NotebookPen, XCircle } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { annotateFlightAction } from '../../actions';

// ─── Props ────────────────────────────────────────────────────────────────────

interface AnnotateFlightDialogProps {
  ticketId: string;
  /** Tail number — used only for the dialog title / button label. */
  tail: string;
  /** Current effective annotation (pre-fill); null when un-annotated. */
  nightHours: number | null;
  instrumentHours: number | null;
  crossCountryHours: number | null;
  remarks: string | null;
}

interface FieldErrors {
  night?: string;
  instrument?: string;
  xc?: string;
  remarks?: string;
}

// ─── Hours parsing (tenths, 0–99.9; empty string = unset) ────────────────────

function parseHoursField(raw: string): { value: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { error: 'Enter a number of hours.' };
  if (n < 0) return { error: 'Hours must be 0 or more.' };
  if (n > 99.9) return { error: 'Hours must be 99.9 or less.' };
  if (Math.round(n * 10) !== n * 10) return { error: 'Use tenths (e.g. 1.2).' };
  return { value: n };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AnnotateFlightDialog({
  ticketId,
  tail,
  nightHours,
  instrumentHours,
  crossCountryHours,
  remarks,
}: AnnotateFlightDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const [night, setNight] = React.useState('');
  const [instrument, setInstrument] = React.useState('');
  const [xc, setXc] = React.useState('');
  const [remarksText, setRemarksText] = React.useState('');

  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Reset form to the current effective annotation whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setNight(nightHours != null ? nightHours.toFixed(1) : '');
    setInstrument(instrumentHours != null ? instrumentHours.toFixed(1) : '');
    setXc(crossCountryHours != null ? crossCountryHours.toFixed(1) : '');
    setRemarksText(remarks ?? '');
    setFieldErrors({});
    setDialogError(null);
  }, [open, nightHours, instrumentHours, crossCountryHours, remarks]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);

    const errors: FieldErrors = {};
    const nightParsed = parseHoursField(night);
    const instrumentParsed = parseHoursField(instrument);
    const xcParsed = parseHoursField(xc);
    if ('error' in nightParsed) errors.night = nightParsed.error;
    if ('error' in instrumentParsed) errors.instrument = instrumentParsed.error;
    if ('error' in xcParsed) errors.xc = xcParsed.error;
    if (remarksText.trim().length > 2000) {
      errors.remarks = 'Remarks must be 2000 characters or fewer.';
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const nightVal = (nightParsed as { value: number | null }).value;
    const instrumentVal = (instrumentParsed as { value: number | null }).value;
    const xcVal = (xcParsed as { value: number | null }).value;
    const remarksVal = remarksText.trim() || null;

    if (nightVal == null && instrumentVal == null && xcVal == null && remarksVal == null) {
      setDialogError('Enter at least one of night, instrument, cross-country, or remarks.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await annotateFlightAction({
        dispatchTicketId: ticketId,
        nightHours: nightVal,
        instrumentHours: instrumentVal,
        crossCountryHours: xcVal,
        remarks: remarksVal,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
        } else if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to annotate this flight.');
        } else {
          setDialogError('Something went wrong. Please try again.');
        }
        return;
      }

      if (!result.ok) {
        setDialogError(
          result.reason === 'not_closed'
            ? 'This flight is not closed yet — only closed flights can be annotated.'
            : 'Flight not found — it may have been removed.',
        );
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const hoursField = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    error: string | undefined,
    clearError: () => void,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        max={99.9}
        step={0.1}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          clearError();
        }}
        placeholder="0.0"
        disabled={isSubmitting}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        className={error ? 'border-red-500' : ''}
      />
      {error && (
        <p id={`${id}-err`} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Annotate flight in ${tail}`}
      >
        <NotebookPen className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
        Annotate
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Annotate flight <span className="nums font-bold">{tail}</span>
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-3 gap-3">
              {hoursField('af-night', 'Night (h)', night, setNight, fieldErrors.night, () =>
                setFieldErrors((prev) => ({ ...prev, night: undefined })),
              )}
              {hoursField(
                'af-instrument',
                'Instrument (h)',
                instrument,
                setInstrument,
                fieldErrors.instrument,
                () => setFieldErrors((prev) => ({ ...prev, instrument: undefined })),
              )}
              {hoursField('af-xc', 'Cross-country (h)', xc, setXc, fieldErrors.xc, () =>
                setFieldErrors((prev) => ({ ...prev, xc: undefined })),
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="af-remarks">Remarks</Label>
              <Textarea
                id="af-remarks"
                value={remarksText}
                onChange={(e) => {
                  setRemarksText(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, remarks: undefined }));
                }}
                rows={3}
                maxLength={2000}
                placeholder="e.g. KOSU–KCMH–KOSU, night landings ×3"
                disabled={isSubmitting}
                aria-invalid={fieldErrors.remarks ? 'true' : undefined}
                aria-describedby={fieldErrors.remarks ? 'af-remarks-err' : undefined}
                className={fieldErrors.remarks ? 'border-red-500' : ''}
              />
              {fieldErrors.remarks && (
                <p id="af-remarks-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {fieldErrors.remarks}
                </p>
              )}
            </div>

            <p className="text-[0.6875rem] text-slate-400 dark:text-slate-500">
              Saving adds a new annotation (the latest one is shown) — earlier
              annotations are kept for the record, never edited. Pilot/operator-entered
              data — not an FAA logbook of record; AeroOps does not compute currency.
            </p>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isSubmitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isSubmitting} isLoading={isSubmitting}>
                Save annotation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
