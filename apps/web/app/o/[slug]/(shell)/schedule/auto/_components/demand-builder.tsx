/**
 * demand-builder.tsx — Form to define sessions for the auto-scheduler.
 *
 * Each demand row specifies:
 *   - Required resources (one aircraft, optional instructor) via pickers
 *   - Duration in minutes (> 0)
 *   - Optional date-range window (earliest start / latest end, epoch ms)
 *   - Optional priority (higher = scheduled first)
 *
 * The form also accepts:
 *   - Overall window (start / end date for the scheduling run)
 *   - Objective (maximize_utilization | maximize_sessions_scheduled)
 *
 * Client component — assembles the AutoScheduleInput for the server actions.
 * Validates inline before submitting; server validation errors are shown inline.
 *
 * A11y: every input has an associated <label>; focus order follows visual order;
 * error messages are linked via aria-describedby.
 */
'use client';

import * as React from 'react';
import { Plus, Trash2, CalendarRange, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { ResourceRow } from '@aeroops/api';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One demand row in the builder UI. */
export interface DemandRow {
  /** Caller-supplied stable id (echoed back in proposals). */
  id: string;
  aircraftId: string;
  instructorId: string;
  durationMinutes: number;
  /** YYYY-MM-DD string — optional per-demand earliest date */
  earliestDate: string;
  /** HH:MM string — optional per-demand earliest time */
  earliestTime: string;
  /** YYYY-MM-DD string — optional per-demand latest date */
  latestDate: string;
  /** HH:MM string — optional per-demand latest time */
  latestTime: string;
  priority: number;
}

/** The assembled input for the auto-schedule actions. */
export interface AutoScheduleFormInput {
  demands: Array<{
    id: string;
    requiredResourceIds: string[];
    durationMinutes: number;
    earliestStartUtcMs?: number;
    latestEndUtcMs?: number;
    priority?: number;
  }>;
  windowStartUtcMs: number;
  windowEndUtcMs: number;
  objective?: 'maximize_utilization' | 'maximize_sessions_scheduled';
}

interface DemandBuilderProps {
  resources: ResourceRow[];
  onPreview: (input: AutoScheduleFormInput) => void;
  isPreviewing: boolean;
  validationError?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _rowCounter = 0;
function nextRowId(): string {
  return `demand-${++_rowCounter}`;
}

function defaultRow(): DemandRow {
  return {
    id: nextRowId(),
    aircraftId: '',
    instructorId: '',
    durationMinutes: 60,
    earliestDate: '',
    earliestTime: '06:00',
    latestDate: '',
    latestTime: '20:00',
    priority: 0,
  };
}

/**
 * localDateTimeToUtcMs — convert a "YYYY-MM-DD" + "HH:MM" pair to epoch ms
 * treating them as LOCAL time in the browser's timezone.
 * Returns undefined when either component is blank.
 */
function localDateTimeToUtcMs(date: string, time: string): number | undefined {
  if (!date || !time) return undefined;
  const d = new Date(`${date}T${time}:00`);
  if (isNaN(d.getTime())) return undefined;
  return d.getTime();
}

// ─── Field errors ─────────────────────────────────────────────────────────────

interface FormErrors {
  windowStart?: string;
  windowEnd?: string;
  demands?: Record<string, {
    aircraftId?: string;
    durationMinutes?: string;
    window?: string;
  }>;
  global?: string;
}

function validateForm(
  rows: DemandRow[],
  windowStartMs: number | undefined,
  windowEndMs: number | undefined,
): FormErrors {
  const errors: FormErrors = {};

  if (!windowStartMs) errors.windowStart = 'Window start is required.';
  if (!windowEndMs) errors.windowEnd = 'Window end is required.';
  if (windowStartMs && windowEndMs && windowEndMs <= windowStartMs) {
    errors.windowEnd = 'Window end must be after window start.';
  }

  if (rows.length === 0) {
    errors.global = 'Add at least one demand to schedule.';
  }

  const demandErrors: FormErrors['demands'] = {};
  for (const row of rows) {
    const rowErr: { aircraftId?: string; durationMinutes?: string; window?: string } = {};
    if (!row.aircraftId) rowErr.aircraftId = 'Select an aircraft.';
    if (!row.durationMinutes || row.durationMinutes <= 0) {
      rowErr.durationMinutes = 'Duration must be greater than 0.';
    }
    // Validate optional per-demand window
    const eMs = localDateTimeToUtcMs(row.earliestDate, row.earliestTime);
    const lMs = localDateTimeToUtcMs(row.latestDate, row.latestTime);
    if (eMs && lMs && lMs <= eMs) {
      rowErr.window = 'Latest end must be after earliest start.';
    }
    if (Object.keys(rowErr).length > 0) demandErrors[row.id] = rowErr;
  }
  if (Object.keys(demandErrors).length > 0) errors.demands = demandErrors;

  return errors;
}

function hasErrors(errors: FormErrors): boolean {
  return !!(
    errors.windowStart ||
    errors.windowEnd ||
    errors.global ||
    (errors.demands && Object.keys(errors.demands).length > 0)
  );
}

// ─── DemandBuilderRow ─────────────────────────────────────────────────────────

interface DemandBuilderRowProps {
  row: DemandRow;
  index: number;
  aircraft: ResourceRow[];
  instructors: ResourceRow[];
  onUpdate: (id: string, patch: Partial<DemandRow>) => void;
  onRemove: (id: string) => void;
  errors?: { aircraftId?: string; durationMinutes?: string; window?: string };
  showRemove: boolean;
}

function DemandBuilderRow({
  row,
  index,
  aircraft,
  instructors,
  onUpdate,
  onRemove,
  errors,
  showRemove,
}: DemandBuilderRowProps) {
  const prefix = `demand-${row.id}`;
  const showPerDemandWindow = !!(row.earliestDate || row.latestDate);

  return (
    <div
      className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
      aria-label={`Session ${index + 1}`}
    >
      {/* Row header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
          Session {index + 1}
        </span>
        {showRemove && (
          <button
            type="button"
            aria-label={`Remove session ${index + 1}`}
            className="text-slate-400 dark:text-slate-500 hover:text-danger transition-colors p-0.5"
            onClick={() => onRemove(row.id)}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Aircraft + instructor */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-aircraft`} className="text-xs">
            Aircraft <span aria-hidden="true" className="text-danger">*</span>
          </Label>
          <select
            id={`${prefix}-aircraft`}
            value={row.aircraftId}
            onChange={(e) => onUpdate(row.id, { aircraftId: e.target.value })}
            className="w-full rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
            aria-describedby={errors?.aircraftId ? `${prefix}-aircraft-err` : undefined}
            aria-invalid={!!errors?.aircraftId}
          >
            <option value="">Select aircraft...</option>
            {aircraft.map((r) => (
              <option key={r.id} value={r.id}>
                {r.tailNumber ? `${r.tailNumber} — ` : ''}{r.displayName}
              </option>
            ))}
          </select>
          {errors?.aircraftId && (
            <p id={`${prefix}-aircraft-err`} className="text-xs text-danger" role="alert">
              {errors.aircraftId}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor={`${prefix}-instructor`} className="text-xs">
            Instructor <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
          </Label>
          <select
            id={`${prefix}-instructor`}
            value={row.instructorId}
            onChange={(e) => onUpdate(row.id, { instructorId: e.target.value })}
            className="w-full rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
          >
            <option value="">No instructor</option>
            {instructors.map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Duration + priority */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-duration`} className="text-xs">
            Duration (min) <span aria-hidden="true" className="text-danger">*</span>
          </Label>
          <Input
            id={`${prefix}-duration`}
            type="number"
            min={1}
            max={1440}
            value={row.durationMinutes}
            onChange={(e) => onUpdate(row.id, { durationMinutes: parseInt(e.target.value, 10) || 0 })}
            className="nums h-8 text-sm"
            aria-describedby={errors?.durationMinutes ? `${prefix}-duration-err` : undefined}
            aria-invalid={!!errors?.durationMinutes}
          />
          {errors?.durationMinutes && (
            <p id={`${prefix}-duration-err`} className="text-xs text-danger" role="alert">
              {errors.durationMinutes}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor={`${prefix}-priority`} className="text-xs">
            Priority <span className="text-slate-400 dark:text-slate-500 font-normal">(higher first)</span>
          </Label>
          <Input
            id={`${prefix}-priority`}
            type="number"
            min={0}
            max={99}
            value={row.priority}
            onChange={(e) => onUpdate(row.id, { priority: parseInt(e.target.value, 10) || 0 })}
            className="nums h-8 text-sm"
          />
        </div>
      </div>

      {/* Per-demand window toggle */}
      <div>
        <button
          type="button"
          className="text-xs text-brand hover:underline flex items-center gap-1"
          onClick={() => {
            if (showPerDemandWindow) {
              onUpdate(row.id, { earliestDate: '', latestDate: '' });
            } else {
              // Seed with today
              const today = new Date().toISOString().slice(0, 10);
              onUpdate(row.id, { earliestDate: today });
            }
          }}
          aria-expanded={showPerDemandWindow}
        >
          <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
          {showPerDemandWindow ? 'Remove date-window constraint' : 'Add date-window constraint (optional)'}
        </button>

        {showPerDemandWindow && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${prefix}-earliest-date`} className="text-xs">Earliest date</Label>
              <Input
                id={`${prefix}-earliest-date`}
                type="date"
                value={row.earliestDate}
                onChange={(e) => onUpdate(row.id, { earliestDate: e.target.value })}
                className="h-8 text-sm"
              />
              <Label htmlFor={`${prefix}-earliest-time`} className="text-xs">Start time</Label>
              <Input
                id={`${prefix}-earliest-time`}
                type="time"
                value={row.earliestTime}
                onChange={(e) => onUpdate(row.id, { earliestTime: e.target.value })}
                className="nums h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${prefix}-latest-date`} className="text-xs">Latest date</Label>
              <Input
                id={`${prefix}-latest-date`}
                type="date"
                value={row.latestDate}
                onChange={(e) => onUpdate(row.id, { latestDate: e.target.value })}
                className="h-8 text-sm"
              />
              <Label htmlFor={`${prefix}-latest-time`} className="text-xs">End time</Label>
              <Input
                id={`${prefix}-latest-time`}
                type="time"
                value={row.latestTime}
                onChange={(e) => onUpdate(row.id, { latestTime: e.target.value })}
                className="nums h-8 text-sm"
              />
            </div>
            {errors?.window && (
              <p className="col-span-2 text-xs text-danger" role="alert">
                {errors.window}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DemandBuilder ────────────────────────────────────────────────────────────

export function DemandBuilder({
  resources,
  onPreview,
  isPreviewing,
  validationError,
}: DemandBuilderProps) {
  const aircraft = resources.filter((r) => r.kind === 'aircraft' && r.active);
  const instructors = resources.filter((r) => r.kind === 'instructor' && r.active);

  // ── Form state ─────────────────────────────────────────────────────────────
  const [rows, setRows] = React.useState<DemandRow[]>([defaultRow()]);
  const [windowStartDate, setWindowStartDate] = React.useState('');
  const [windowStartTime, setWindowStartTime] = React.useState('06:00');
  const [windowEndDate, setWindowEndDate] = React.useState('');
  const [windowEndTime, setWindowEndTime] = React.useState('20:00');
  const [objective, setObjective] = React.useState<
    'maximize_utilization' | 'maximize_sessions_scheduled'
  >('maximize_sessions_scheduled');
  const [showObjective, setShowObjective] = React.useState(false);
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [submitted, setSubmitted] = React.useState(false);

  function updateRow(id: string, patch: Partial<DemandRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, defaultRow()]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function buildAndValidate(): AutoScheduleFormInput | null {
    const windowStartMs = localDateTimeToUtcMs(windowStartDate, windowStartTime);
    const windowEndMs = localDateTimeToUtcMs(windowEndDate, windowEndTime);
    const errs = validateForm(rows, windowStartMs, windowEndMs);
    setErrors(errs);
    if (hasErrors(errs)) return null;

    return {
      demands: rows.map((row) => {
        const requiredResourceIds: string[] = [row.aircraftId];
        if (row.instructorId) requiredResourceIds.push(row.instructorId);
        return {
          id: row.id,
          requiredResourceIds,
          durationMinutes: row.durationMinutes,
          ...(localDateTimeToUtcMs(row.earliestDate, row.earliestTime) !== undefined
            ? { earliestStartUtcMs: localDateTimeToUtcMs(row.earliestDate, row.earliestTime) }
            : {}),
          ...(localDateTimeToUtcMs(row.latestDate, row.latestTime) !== undefined
            ? { latestEndUtcMs: localDateTimeToUtcMs(row.latestDate, row.latestTime) }
            : {}),
          ...(row.priority > 0 ? { priority: row.priority } : {}),
        };
      }),
      windowStartUtcMs: windowStartMs!,
      windowEndUtcMs: windowEndMs!,
      objective,
    };
  }

  function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    const input = buildAndValidate();
    if (input) onPreview(input);
  }

  // Re-validate on change once the form has been submitted once.
  React.useEffect(() => {
    if (!submitted) return;
    const windowStartMs = localDateTimeToUtcMs(windowStartDate, windowStartTime);
    const windowEndMs = localDateTimeToUtcMs(windowEndDate, windowEndTime);
    const errs = validateForm(rows, windowStartMs, windowEndMs);
    setErrors(errs);
  }, [rows, windowStartDate, windowStartTime, windowEndDate, windowEndTime, submitted]);

  const hasResources = aircraft.length > 0;

  return (
    <form onSubmit={handlePreview} noValidate className="space-y-6">
      {/* ── Global window ────────────────────────────────────────────────────── */}
      <section aria-labelledby="window-heading">
        <h2 id="window-heading" className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          Scheduling window
        </h2>
        <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <fieldset className="space-y-2 border-0 p-0 m-0">
            <legend className="text-xs font-medium text-slate-600 dark:text-slate-300">
              From <span aria-hidden="true" className="text-danger">*</span>
            </legend>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="window-start-date" className="sr-only">Start date</Label>
                <Input
                  id="window-start-date"
                  type="date"
                  value={windowStartDate}
                  onChange={(e) => setWindowStartDate(e.target.value)}
                  className="h-9 text-sm"
                  aria-describedby={errors.windowStart ? 'window-start-err' : undefined}
                  aria-invalid={!!errors.windowStart}
                />
              </div>
              <div className="w-28 space-y-1">
                <Label htmlFor="window-start-time" className="sr-only">Start time</Label>
                <Input
                  id="window-start-time"
                  type="time"
                  value={windowStartTime}
                  onChange={(e) => setWindowStartTime(e.target.value)}
                  className="nums h-9 text-sm"
                />
              </div>
            </div>
            {errors.windowStart && (
              <p id="window-start-err" className="text-xs text-danger" role="alert">
                {errors.windowStart}
              </p>
            )}
          </fieldset>

          <fieldset className="space-y-2 border-0 p-0 m-0">
            <legend className="text-xs font-medium text-slate-600 dark:text-slate-300">
              To <span aria-hidden="true" className="text-danger">*</span>
            </legend>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="window-end-date" className="sr-only">End date</Label>
                <Input
                  id="window-end-date"
                  type="date"
                  value={windowEndDate}
                  onChange={(e) => setWindowEndDate(e.target.value)}
                  className="h-9 text-sm"
                  aria-describedby={errors.windowEnd ? 'window-end-err' : undefined}
                  aria-invalid={!!errors.windowEnd}
                />
              </div>
              <div className="w-28">
                <Label htmlFor="window-end-time" className="sr-only">End time</Label>
                <Input
                  id="window-end-time"
                  type="time"
                  value={windowEndTime}
                  onChange={(e) => setWindowEndTime(e.target.value)}
                  className="nums h-9 text-sm"
                />
              </div>
            </div>
            {errors.windowEnd && (
              <p id="window-end-err" className="text-xs text-danger" role="alert">
                {errors.windowEnd}
              </p>
            )}
          </fieldset>
        </div>
      </section>

      {/* ── Demand rows ───────────────────────────────────────────────────────── */}
      <section aria-labelledby="demands-heading">
        <h2 id="demands-heading" className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
          Sessions to schedule
        </h2>

        {!hasResources && (
          <Alert>
            <AlertDescription>
              No active aircraft found. Add resources before using the auto-scheduler.
            </AlertDescription>
          </Alert>
        )}

        {errors.global && (
          <Alert variant="destructive" role="alert" className="mb-3">
            <AlertDescription>{errors.global}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          {rows.map((row, i) => (
            <DemandBuilderRow
              key={row.id}
              row={row}
              index={i}
              aircraft={aircraft}
              instructors={instructors}
              onUpdate={updateRow}
              onRemove={removeRow}
              errors={errors.demands?.[row.id]}
              showRemove={rows.length > 1}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={addRow}
          className="mt-3 text-sm text-brand hover:underline flex items-center gap-1"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add session
        </button>
      </section>

      {/* ── Objective (advanced) ─────────────────────────────────────────────── */}
      <section>
        <button
          type="button"
          className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1"
          onClick={() => setShowObjective((v) => !v)}
          aria-expanded={showObjective}
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          Advanced options
        </button>

        {showObjective && (
          <div className="mt-3 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
            <Label htmlFor="objective" className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Objective
            </Label>
            <select
              id="objective"
              value={objective}
              onChange={(e) =>
                setObjective(e.target.value as 'maximize_utilization' | 'maximize_sessions_scheduled')
              }
              className="w-full rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
            >
              <option value="maximize_sessions_scheduled">Maximize sessions scheduled</option>
              <option value="maximize_utilization">Maximize utilization</option>
            </select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Both objectives produce deterministic results for the same input.
            </p>
          </div>
        )}
      </section>

      {/* ── Server validation error ───────────────────────────────────────────── */}
      {validationError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      {/* ── Primary action: Preview ───────────────────────────────────────────── */}
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={isPreviewing || !hasResources}
          className="min-w-[120px]"
        >
          {isPreviewing ? 'Previewing…' : 'Preview'}
        </Button>
      </div>
    </form>
  );
}
