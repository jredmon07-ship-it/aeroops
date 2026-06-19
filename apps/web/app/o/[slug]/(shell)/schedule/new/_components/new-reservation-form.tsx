/**
 * new-reservation-form.tsx — Full booking form with live conflict preview.
 *
 * Client component. Fed initial resources + slug from the RSC page.
 * Spec §4: date, start/end times, aircraft select, optional instructor select,
 * notes textarea, conflict banner, dirty-form guard, submit handling.
 *
 * Slice 2b extension: "Repeat" toggle. OFF → existing single-create path
 * (UNCHANGED). ON → recurrence controls + live previewSeriesAction debounce
 * + createSeriesAction submit → create-result screen.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PlaneTakeoff, Repeat2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ConflictBanner } from './conflict-banner';
import { RecurrenceControls } from './recurrence-controls';
import { SeriesPreviewPanel } from './series-preview-panel';
import { SeriesCreateResult } from './series-create-result';
import { TwilightIndicator } from './twilight-indicator';
import { useConflictCheck } from '../_hooks/use-conflict-check';
import { useSeriesPreview } from '../_hooks/use-series-preview';
import { createReservationAction, createSeriesAction, previewTwilightAction } from '../../actions';
import { getGroundingStatusAction } from '../../../maintenance/actions';
import { toDateInputValue } from '../../_utils/format-time';
import type { ResourceRow, ConflictHit, PolicyViolationView, CreateSeriesResult, GroundingStatusView, PreviewTwilightResourceReport, TwilightHit } from '@aeroops/api';
import type { RecurrenceValue, RecurrenceFieldErrors } from './recurrence-controls';
import type { TwilightPreviewState } from './twilight-indicator';

interface NewReservationFormProps {
  resources: ResourceRow[];
  slug: string;
  /** Initial date from ?date= query param — YYYY-MM-DD or empty */
  initialDate: string;
  canManageResources: boolean;
  /** href for the "Back to Schedule" button rendered inside this client boundary */
  backHref: string;
}

interface FieldErrors {
  date?: string;
  startTime?: string;
  endTime?: string;
  resources?: string;
  notes?: string;
}

/** Derive the ISO weekday (1=Mon..7=Sun) from a YYYY-MM-DD string. */
function isoWeekdayFromDate(dateStr: string): number {
  if (!dateStr || dateStr.length !== 10) return 1;
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return 1;
  // getDay(): 0=Sun..6=Sat → map to ISO 1=Mon..7=Sun
  const day = d.getDay();
  return day === 0 ? 7 : day;
}

/** Get the browser's IANA timezone. */
function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function NewReservationForm({
  resources,
  slug,
  initialDate,
  canManageResources,
  backHref,
}: NewReservationFormProps) {
  const router = useRouter();
  const dateRef = React.useRef<HTMLInputElement>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);

  const [date, setDate] = React.useState(initialDate || toDateInputValue(new Date()));
  const [startTime, setStartTime] = React.useState('');
  const [endTime, setEndTime] = React.useState('');
  const [aircraftId, setAircraftId] = React.useState('');
  const [instructorId, setInstructorId] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [submitConflicts, setSubmitConflicts] = React.useState<ConflictHit[]>([]);
  const [submitViolations, setSubmitViolations] = React.useState<PolicyViolationView[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [groundingWarnings, setGroundingWarnings] = React.useState<Array<{ resourceId: string; reason: string | null }>>([]);
  // twilightWarnings: populated on both block (ok:false) and warn (ok:true).
  // twilightBlocked: true = block mode (nothing created); false = warn (created).
  const [twilightWarnings, setTwilightWarnings] = React.useState<TwilightHit[]>([]);
  const [twilightBlocked, setTwilightBlocked] = React.useState(false);

  // Grounding status for aircraft — fetched once on mount, used for inline wedge badge.
  const [groundingStatus, setGroundingStatus] = React.useState<Map<string, GroundingStatusView>>(new Map());

  // Civil-twilight preview (Slice 4a) — advisory indicator, never blocks the form.
  const [twilightState, setTwilightState] = React.useState<TwilightPreviewState>('idle');
  const [twilightPerResource, setTwilightPerResource] = React.useState<PreviewTwilightResourceReport[]>([]);
  const twilightTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Recurrence (Slice 2b) ──────────────────────────────────────────────────
  const [repeatEnabled, setRepeatEnabled] = React.useState(false);
  const [recurrence, setRecurrence] = React.useState<RecurrenceValue>(() => ({
    weekdays: [isoWeekdayFromDate(initialDate || toDateInputValue(new Date()))],
    intervalWeeks: 1,
    end: { kind: 'count', count: 4 },
    tz: browserTz(),
  }));
  const [recurrenceErrors, setRecurrenceErrors] = React.useState<RecurrenceFieldErrors>({});
  // Post-submit result screen state
  const [seriesResult, setSeriesResult] = React.useState<CreateSeriesResult | null>(null);

  // Dirty-form guard state
  const [pendingNav, setPendingNav] = React.useState<string | null>(null);

  // Filter resources by kind and active only
  const aircraft = resources
    .filter((r) => r.kind === 'aircraft' && r.active)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const instructors = resources
    .filter((r) => r.kind === 'instructor' && r.active)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const noResources = aircraft.length === 0 && instructors.length === 0;

  // Build resourceIds for conflict check and submission
  const resourceIds = React.useMemo(() => {
    const ids: string[] = [];
    if (aircraftId) ids.push(aircraftId);
    if (instructorId) ids.push(instructorId);
    return ids;
  }, [aircraftId, instructorId]);

  // Live combined conflict + policy preview (single-create path, Repeat OFF)
  const { state: conflictState, conflicts, policyViolations } = useConflictCheck({
    date,
    startTime,
    endTime,
    resourceIds,
  });

  // Series preview (Repeat ON)
  const { state: previewState, preview, errorMessage: previewError } = useSeriesPreview({
    date,
    startTime,
    endTime,
    resourceIds,
    weekdays: recurrence.weekdays,
    intervalWeeks: recurrence.intervalWeeks,
    end: recurrence.end,
    tz: recurrence.tz,
    repeatEnabled,
  });

  // Is form "dirty" (has user entered anything)?
  const isDirty = !!(
    (date && date !== toDateInputValue(new Date())) ||
    startTime ||
    endTime ||
    aircraftId ||
    instructorId ||
    notes ||
    repeatEnabled
  );

  // beforeunload: guard on refresh / tab-close when form is dirty (spec §4)
  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        // Modern browsers ignore the returned string but require returnValue to be set.
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Autofocus date on mount
  React.useEffect(() => {
    dateRef.current?.focus();
  }, []);

  // Fetch grounding status for aircraft on mount (non-fatal — badge shown to all who can book).
  React.useEffect(() => {
    const aircraftIds = aircraft.map((r) => r.id);
    if (aircraftIds.length === 0) return;
    let cancelled = false;
    getGroundingStatusAction({ resourceIds: aircraftIds }).then((result) => {
      if (cancelled) return;
      if ('ok' in result && result.ok) {
        setGroundingStatus(new Map(result.entries));
      }
    }).catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount — resources don't change during session

  // Civil-twilight preview (Slice 4a, advisory only — never blocks submit).
  // Debounce 500ms; fires when aircraft + date + start + end are all set.
  React.useEffect(() => {
    if (twilightTimerRef.current) clearTimeout(twilightTimerRef.current);

    // Only preview if we have aircraft selected and a full time window.
    if (!aircraftId || !date || !startTime || !endTime) {
      setTwilightState('idle');
      setTwilightPerResource([]);
      return;
    }

    const startAt = new Date(`${date}T${startTime}:00`);
    const endAt = new Date(`${date}T${endTime}:00`);
    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
      setTwilightState('idle');
      setTwilightPerResource([]);
      return;
    }

    setTwilightState('loading');

    twilightTimerRef.current = setTimeout(async () => {
      const ids: string[] = [aircraftId];
      try {
        const result = await previewTwilightAction({ startAt, endAt, resourceIds: ids });
        if ('error' in result) {
          setTwilightState('error');
          return;
        }
        setTwilightPerResource(result.perResource);
        setTwilightState('loaded');
      } catch {
        setTwilightState('error');
      }
    }, 500);

    return () => {
      if (twilightTimerRef.current) clearTimeout(twilightTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aircraftId, date, startTime, endTime]);

  // Client-side validation for the base fields (shared by both paths)
  function validateBase(): boolean {
    const errors: FieldErrors = {};

    if (!date) {
      errors.date = 'Date is required.';
    }

    if (!startTime) {
      errors.startTime = 'Start time is required.';
    }

    if (!endTime) {
      errors.endTime = 'End time is required.';
    } else if (startTime && endTime) {
      const s = new Date(`${date}T${startTime}:00`);
      const e = new Date(`${date}T${endTime}:00`);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e <= s) {
        errors.endTime = 'End time must be after start time.';
      }
    }

    if (resourceIds.length === 0) {
      errors.resources = 'Select at least one resource.';
    }

    setFieldErrors(errors);

    if (Object.keys(errors).length > 0) {
      if (errors.date) dateRef.current?.focus();
      return false;
    }

    return true;
  }

  // Client-side validation for recurrence fields (Repeat ON path)
  function validateRecurrence(): boolean {
    const errors: RecurrenceFieldErrors = {};

    if (recurrence.weekdays.length === 0) {
      errors.weekdays = 'Choose at least one weekday.';
    }

    if (recurrence.intervalWeeks < 1) {
      errors.intervalWeeks = 'Interval must be at least 1 week.';
    }

    if (recurrence.end.kind === 'count') {
      if (recurrence.end.count < 1 || recurrence.end.count > 52) {
        errors.count = 'Count must be between 1 and 52.';
      }
    } else {
      if (!recurrence.end.untilDate || recurrence.end.untilDate.length !== 10) {
        errors.untilDate = 'Enter a valid end date.';
      }
    }

    if (!recurrence.tz.trim()) {
      errors.tz = 'Timezone is required.';
    }

    setRecurrenceErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // Build a map of aircraft id → display label for the TwilightIndicator.
  const aircraftNameMap = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of aircraft) {
      m.set(r.id, r.tailNumber ? `${r.tailNumber} — ${r.displayName}` : r.displayName);
    }
    return m;
  }, [aircraft]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setSubmitConflicts([]);
    setSubmitViolations([]);
    setTwilightWarnings([]);
    setTwilightBlocked(false);

    if (!validateBase()) return;

    // ── Repeat ON: series path ───────────────────────────────────────────────
    if (repeatEnabled) {
      if (!validateRecurrence()) return;

      setSubmitting(true);
      try {
        const startAt = new Date(`${date}T${startTime}:00`);
        const endAt = new Date(`${date}T${endTime}:00`);
        const durationMinutes = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);

        const result = await createSeriesAction({
          weekdays: recurrence.weekdays,
          intervalWeeks: recurrence.intervalWeeks,
          end: recurrence.end,
          localStartTime: startTime,
          durationMinutes,
          tz: recurrence.tz,
          resourceIds,
          notes: notes.trim() || undefined,
        });

        if ('error' in result) {
          if (result.error === 'validation') {
            setServerError(`Invalid series: ${result.message}`);
            errorRef.current?.focus();
          } else if (result.error === 'forbidden' || result.error === 'unauthenticated') {
            setServerError('You do not have permission to create reservations.');
            errorRef.current?.focus();
          } else {
            setServerError('Something went wrong. Please try again.');
            errorRef.current?.focus();
          }
          return;
        }

        // ok:true — show result screen (partial-create is normal; result always ok:true)
        setSeriesResult(result);
      } catch {
        setServerError('Something went wrong. Please try again.');
        errorRef.current?.focus();
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // ── Repeat OFF: single-create path (UNCHANGED) ───────────────────────────
    setSubmitting(true);

    try {
      const startAt = new Date(`${date}T${startTime}:00`);
      const endAt = new Date(`${date}T${endTime}:00`);

      const result = await createReservationAction({
        startAt,
        endAt,
        resourceIds,
        notes: notes.trim() || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setServerError(`Invalid reservation: ${result.message}`);
          errorRef.current?.focus();
        } else {
          setServerError('Something went wrong. Please try again.');
          errorRef.current?.focus();
        }
        return;
      }

      if (!result.ok) {
        // Map all ok:false arms — render via banner with hard-block framing.
        if (result.reason === 'conflict_and_policy') {
          setSubmitConflicts(result.conflicts);
          setSubmitViolations(result.violations);
        } else if (result.reason === 'policy') {
          setSubmitConflicts([]);
          setSubmitViolations(result.violations);
        } else if (result.reason === 'twilight') {
          // Slice 4a — block mode: refused because of civil twilight violation.
          // Show the boundary times; nothing was written.
          setTwilightWarnings(result.twilight);
          setTwilightBlocked(true);
        } else {
          // reason === 'conflict' — FROZEN Slice-1 arm
          setSubmitConflicts(result.conflicts);
          setSubmitViolations([]);
        }
        return;
      }

      // Surface any twilight warnings (warn mode — reservation WAS created).
      // Show non-blocking notice before redirect.
      if (result.twilightWarnings && result.twilightWarnings.length > 0) {
        setTwilightWarnings(result.twilightWarnings);
        setTwilightBlocked(false);
        // No grounding warning — show twilight notice + let user proceed.
        if (!result.groundingWarnings || result.groundingWarnings.length === 0) {
          return;
        }
      }

      // Surface any grounding warnings before navigating away.
      // The reservation was created successfully; this is a non-blocking advisory.
      if (result.groundingWarnings && result.groundingWarnings.length > 0) {
        setGroundingWarnings(result.groundingWarnings);
        // Don't redirect yet — show the warning and let the user dismiss.
        return;
      }

      // Success — redirect to list with date+start+end for spec §4 copy
      router.push(
        `/o/${slug}/schedule?date=${date}&success=1&start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}`,
      );
    } catch {
      setServerError('Something went wrong. Please try again.');
      errorRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Generic navigation guard for any exit affordance the form owns.
   * If the form is dirty, intercept and open the discard dialog; otherwise
   * let the navigation proceed immediately.
   */
  function handleGuardedNav(e: React.MouseEvent, href: string) {
    if (isDirty) {
      e.preventDefault();
      setPendingNav(href);
    }
  }

  function handleCancelClick(e: React.MouseEvent) {
    handleGuardedNav(e, `/o/${slug}/schedule?date=${date}`);
  }

  function handleBackClick(e: React.MouseEvent) {
    handleGuardedNav(e, backHref);
  }

  // ── Series create result screen ────────────────────────────────────────────
  if (seriesResult) {
    return (
      <SeriesCreateResult
        result={seriesResult}
        slug={slug}
        onReset={() => {
          setSeriesResult(null);
          setRepeatEnabled(false);
          setDate(toDateInputValue(new Date()));
          setStartTime('');
          setEndTime('');
          setAircraftId('');
          setInstructorId('');
          setNotes('');
          setRecurrenceErrors({});
          setServerError(null);
        }}
      />
    );
  }

  // Empty state: no resources to book
  if (noResources) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-4">
        <PlaneTakeoff className="h-12 w-12 text-slate-300" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-slate-700 font-medium">No resources to book yet.</p>
          <p className="text-sm text-slate-500 max-w-sm">
            An administrator must add at least one aircraft or instructor before
            you can create a reservation.
          </p>
        </div>
        {canManageResources && (
          <Button asChild variant="outline">
            <Link href={`/o/${slug}/schedule/resources`}>Add a Resource</Link>
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {/* "Back to Schedule" button — rendered here (client boundary) so it
          participates in the dirty-form guard (spec §4). The RSC page renders
          only the <h1> heading. */}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleBackClick}
          asChild={!isDirty}
        >
          {isDirty ? (
            <span>Back to Schedule</span>
          ) : (
            <Link href={backHref}>Back to Schedule</Link>
          )}
        </Button>
      </div>

      {/* Dirty-form guard dialog */}
      <AlertDialog open={pendingNav !== null} onOpenChange={(open) => { if (!open) setPendingNav(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard reservation?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Leaving this page will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus onClick={() => setPendingNav(null)}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingNav) router.push(pendingNav);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <form onSubmit={handleSubmit} noValidate className="space-y-6 max-w-lg">
        {/* Grounding warning banner — shown when create succeeded with groundingWarnings */}
        {groundingWarnings.length > 0 && (
          <Alert className="border-amber-200 bg-amber-50" role="alert">
            <AlertDescription className="space-y-2">
              <p className="font-medium text-amber-900">
                Reservation created — but one or more aircraft are grounded:
              </p>
              <ul className="list-disc list-inside text-sm text-amber-800 space-y-0.5">
                {groundingWarnings.map((w) => {
                  const res = aircraft.find((r) => r.id === w.resourceId);
                  const name = res?.tailNumber ?? res?.displayName ?? w.resourceId;
                  return (
                    <li key={w.resourceId}>
                      <span className="nums font-mono">{name}</span>
                      {w.reason ? `: ${w.reason}` : ''}
                    </li>
                  );
                })}
              </ul>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/o/${slug}/schedule?date=${date}&success=1&start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}`,
                    )
                  }
                  className="text-sm text-amber-800 underline"
                >
                  Continue to schedule
                </button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Server / validation error */}
        {serverError && (
          <Alert
            ref={errorRef}
            variant="destructive"
            role="alert"
            tabIndex={-1}
          >
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        {/* Submit-blocked banner (conflict and/or policy) */}
        {(submitConflicts.length > 0 || submitViolations.length > 0) && (
          <ConflictBanner
            state="conflict"
            conflicts={[]}
            submitConflicts={submitConflicts}
            submitViolations={submitViolations}
          />
        )}

        {/* Twilight block banner — ok:false reason:'twilight' (block mode).
            Nothing was written. Show boundary times so user can adjust.
            [VERIFY-4a-A] Astronomy-only; NOT an FAA night-currency determination. */}
        {twilightWarnings.length > 0 && twilightBlocked && (
          <Alert variant="destructive" role="alert" aria-live="assertive">
            <AlertDescription>
              <p className="font-medium mb-1">
                This booking was not created due to civil-twilight rules:
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-sm">
                {twilightWarnings.map((hit, i) => {
                  const time = new Intl.DateTimeFormat(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  }).format(new Date(hit.boundaryUtcMs));
                  const copy =
                    hit.reason === 'ends_after_civil_dusk'
                      ? `This booking ends after civil dusk (${time}). Adjust the time or enable a night-qualified exemption.`
                      : `This booking starts before civil dawn (${time}). Adjust the time or enable a night-qualified exemption.`;
                  return <li key={i}>{copy}</li>;
                })}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Twilight warn notice — ok:true with twilightWarnings (warn mode).
            Reservation WAS created. Non-blocking advisory.
            [VERIFY-4a-A] Astronomy-only; NOT an FAA night-currency determination. */}
        {twilightWarnings.length > 0 && !twilightBlocked && (
          <Alert className="border-amber-200 bg-amber-50" role="status" aria-live="polite">
            <AlertDescription className="space-y-1">
              <p className="font-medium text-amber-900">
                Booked. Note: this booking crosses your civil-twilight scheduling boundary.
              </p>
              <ul className="list-disc list-inside text-sm text-amber-800 space-y-0.5">
                {twilightWarnings.map((hit, i) => {
                  const time = new Intl.DateTimeFormat(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  }).format(new Date(hit.boundaryUtcMs));
                  const copy =
                    hit.reason === 'ends_after_civil_dusk'
                      ? `Ends after civil dusk (${time}).`
                      : `Starts before civil dawn (${time}).`;
                  return <li key={i}>{copy}</li>;
                })}
              </ul>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/o/${slug}/schedule?date=${date}&success=1&start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}`,
                    )
                  }
                  className="text-sm text-amber-800 underline"
                >
                  Continue to schedule
                </button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Date */}
        <div className="space-y-1">
          <Label htmlFor="date">
            Date <span aria-hidden="true">*</span>
          </Label>
          <Input
            ref={dateRef}
            id="date"
            type="date"
            value={date}
            onChange={(e) => {
              const newDate = e.target.value;
              setDate(newDate);
              setFieldErrors((prev) => ({ ...prev, date: undefined }));
              // When Repeat is OFF and weekdays haven't been customised (still
              // matches the old date's weekday), track the new date's weekday.
              const oldWeekday = isoWeekdayFromDate(date);
              if (
                !repeatEnabled &&
                recurrence.weekdays.length === 1 &&
                recurrence.weekdays[0] === oldWeekday
              ) {
                setRecurrence((prev) => ({
                  ...prev,
                  weekdays: [isoWeekdayFromDate(newDate)],
                }));
              }
            }}
            required
            aria-required="true"
            aria-describedby={fieldErrors.date ? 'date-error' : undefined}
            className={fieldErrors.date ? 'border-red-500' : ''}
          />
          {fieldErrors.date && (
            <p id="date-error" role="alert" className="text-sm text-red-600">
              {fieldErrors.date}
            </p>
          )}
        </div>

        {/* Start / End times — side-by-side at sm */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="startTime">
              Start time <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="startTime"
              type="time"
              step={300}
              value={startTime}
              onChange={(e) => {
                setStartTime(e.target.value);
                setFieldErrors((prev) => ({ ...prev, startTime: undefined }));
              }}
              required
              aria-required="true"
              aria-describedby={fieldErrors.startTime ? 'startTime-error' : undefined}
              className={fieldErrors.startTime ? 'border-red-500' : ''}
            />
            {fieldErrors.startTime && (
              <p id="startTime-error" role="alert" className="text-sm text-red-600">
                {fieldErrors.startTime}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="endTime">
              End time <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="endTime"
              type="time"
              step={300}
              value={endTime}
              onChange={(e) => {
                setEndTime(e.target.value);
                setFieldErrors((prev) => ({ ...prev, endTime: undefined }));
              }}
              required
              aria-required="true"
              aria-describedby={fieldErrors.endTime ? 'endTime-error' : undefined}
              className={fieldErrors.endTime ? 'border-red-500' : ''}
            />
            {fieldErrors.endTime && (
              <p id="endTime-error" role="alert" className="text-sm text-red-600">
                {fieldErrors.endTime}
              </p>
            )}
          </div>
        </div>

        {/* Aircraft select */}
        <div className="space-y-1">
          <Label htmlFor="aircraftId">
            Aircraft <span aria-hidden="true">*</span>
          </Label>
          <select
            id="aircraftId"
            value={aircraftId}
            onChange={(e) => {
              setAircraftId(e.target.value);
              setFieldErrors((prev) => ({ ...prev, resources: undefined }));
            }}
            aria-describedby={
              [
                fieldErrors.resources ? 'resources-error' : null,
                aircraftId && groundingStatus.get(aircraftId)?.grounded ? 'aircraft-grounded-warning' : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">— Select —</option>
            {aircraft.map((r) => {
              const grounded = groundingStatus.get(r.id)?.grounded === true;
              const label = r.tailNumber ? `${r.tailNumber} — ${r.displayName}` : r.displayName;
              return (
                <option key={r.id} value={r.id}>
                  {grounded ? `[Grounded] ${label}` : label}
                </option>
              );
            })}
          </select>

          {/* Inline grounded warning — shows when a grounded aircraft is selected */}
          {aircraftId && (() => {
            const status = groundingStatus.get(aircraftId);
            if (!status?.grounded) return null;
            return (
              <div
                id="aircraft-grounded-warning"
                role="status"
                className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm"
              >
                <span className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1 text-[10px] font-semibold text-destructive leading-5 shrink-0">
                  Grounded
                </span>
                <span className="text-amber-900">
                  {status.reason
                    ? `This aircraft is grounded: ${status.reason}. You may still book, but dispatch will be blocked until released.`
                    : 'This aircraft is grounded. You may still book, but dispatch will be blocked until released.'}
                </span>
              </div>
            );
          })()}

          {fieldErrors.resources && (
            <p id="resources-error" role="alert" className="text-sm text-red-600">
              {fieldErrors.resources}
            </p>
          )}
        </div>

        {/* Instructor select (optional) */}
        <div className="space-y-1">
          <Label htmlFor="instructorId">Instructor (optional)</Label>
          <select
            id="instructorId"
            value={instructorId}
            onChange={(e) => setInstructorId(e.target.value)}
            className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">— None —</option>
            {instructors.map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName}
              </option>
            ))}
          </select>
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <Label htmlFor="notes">Notes (optional)</Label>
          <Textarea
            id="notes"
            rows={3}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional information…"
          />
        </div>

        {/* ── Repeat toggle (Slice 2b) ────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <button
            id="repeatToggle"
            type="button"
            role="switch"
            aria-checked={repeatEnabled}
            aria-label="Repeat this reservation weekly"
            onClick={() => {
              const next = !repeatEnabled;
              setRepeatEnabled(next);
              if (next) {
                // Default weekday to today's anchor date when first enabled
                setRecurrence((prev) => ({
                  ...prev,
                  weekdays: prev.weekdays.length > 0
                    ? prev.weekdays
                    : [isoWeekdayFromDate(date)],
                }));
              }
            }}
            className={[
              'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2',
              repeatEnabled ? 'bg-sky-600' : 'bg-slate-200',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className={[
                'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform',
                repeatEnabled ? 'translate-x-5' : 'translate-x-0',
              ].join(' ')}
            />
          </button>
          <Label htmlFor="repeatToggle" className="flex items-center gap-1.5 cursor-pointer select-none">
            <Repeat2 className="h-4 w-4 text-slate-500" aria-hidden="true" />
            Repeat weekly
          </Label>
        </div>

        {/* Recurrence controls — visible when Repeat ON */}
        {repeatEnabled && (
          <RecurrenceControls
            value={recurrence}
            onChange={setRecurrence}
            errors={recurrenceErrors}
            onClearError={(field) =>
              setRecurrenceErrors((prev) => ({ ...prev, [field]: undefined }))
            }
          />
        )}

        {/* Live preview panel (Repeat ON) */}
        {repeatEnabled && (
          <SeriesPreviewPanel
            state={previewState}
            preview={preview}
            errorMessage={previewError}
            tz={recurrence.tz}
          />
        )}

        {/* Live single-reservation conflict/policy banner (Repeat OFF only) */}
        {!repeatEnabled && submitConflicts.length === 0 && submitViolations.length === 0 && (
          <ConflictBanner
            state={conflictState}
            conflicts={conflicts}
            policyViolations={policyViolations}
          />
        )}

        {/* Civil-twilight day/night indicator (Slice 4a, advisory only).
            Shown when aircraft is selected and time window is set.
            Never blocks submit — informational only.
            [VERIFY-4a-A] astronomy, not FAA night-currency or §61.57. */}
        {!repeatEnabled && aircraftId && (
          <TwilightIndicator
            state={twilightState}
            perResource={twilightPerResource}
            resourceNames={aircraftNameMap}
          />
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            asChild={!isDirty}
            onClick={isDirty ? handleCancelClick : undefined}
          >
            {isDirty ? (
              <span>Cancel</span>
            ) : (
              <Link href={`/o/${slug}/schedule?date=${date}`}>Cancel</Link>
            )}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting
              ? repeatEnabled ? 'Creating series…' : 'Booking…'
              : repeatEnabled ? 'Preview & create series' : 'Book Reservation'}
          </Button>
        </div>
      </form>
    </>
  );
}
