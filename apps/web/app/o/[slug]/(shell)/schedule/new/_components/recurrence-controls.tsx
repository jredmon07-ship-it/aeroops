/**
 * recurrence-controls.tsx — Recurrence field group for the new-reservation form.
 *
 * Rendered when the "Repeat" toggle is ON. Exposes:
 *   - Weekday multi-select (checkboxes, default = start date's weekday, ISO 1=Mon..7=Sun)
 *   - Interval ("every N weeks", default 1, 1..52)
 *   - End config: radio "for N occurrences" (1..52) | "until date" (YYYY-MM-DD)
 *   - Timezone (text input, defaulted from Intl, operator-confirmable)
 *
 * A11y: fieldsets with legends, labels with htmlFor, inline validation via
 * role="alert" paragraphs (passed from parent field-error state).
 */
'use client';

import * as React from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

export interface RecurrenceValue {
  weekdays: number[];
  intervalWeeks: number;
  end: { kind: 'count'; count: number } | { kind: 'until'; untilDate: string };
  tz: string;
}

export interface RecurrenceFieldErrors {
  weekdays?: string;
  intervalWeeks?: string;
  count?: string;
  untilDate?: string;
  tz?: string;
}

interface RecurrenceControlsProps {
  value: RecurrenceValue;
  onChange: (next: RecurrenceValue) => void;
  errors: RecurrenceFieldErrors;
  onClearError: (field: keyof RecurrenceFieldErrors) => void;
}

const WEEKDAYS: { iso: number; short: string; label: string }[] = [
  { iso: 1, short: 'M', label: 'Monday' },
  { iso: 2, short: 'T', label: 'Tuesday' },
  { iso: 3, short: 'W', label: 'Wednesday' },
  { iso: 4, short: 'Th', label: 'Thursday' },
  { iso: 5, short: 'F', label: 'Friday' },
  { iso: 6, short: 'Sa', label: 'Saturday' },
  { iso: 7, short: 'Su', label: 'Sunday' },
];

export function RecurrenceControls({
  value,
  onChange,
  errors,
  onClearError,
}: RecurrenceControlsProps) {
  function toggleWeekday(iso: number) {
    const next = value.weekdays.includes(iso)
      ? value.weekdays.filter((d) => d !== iso)
      : [...value.weekdays, iso].sort((a, b) => a - b);
    onChange({ ...value, weekdays: next });
    onClearError('weekdays');
  }

  function setEndKind(kind: 'count' | 'until') {
    if (kind === 'count') {
      onChange({ ...value, end: { kind: 'count', count: 4 } });
    } else {
      onChange({ ...value, end: { kind: 'until', untilDate: '' } });
    }
  }

  return (
    <div className="space-y-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
      {/* Weekday picker */}
      <fieldset>
        <legend className="text-sm font-medium text-slate-900 mb-2">
          Repeat on <span aria-hidden="true">*</span>
        </legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Days of week">
          {WEEKDAYS.map(({ iso, short, label }) => {
            const checked = value.weekdays.includes(iso);
            const id = `weekday-${iso}`;
            return (
              <label
                key={iso}
                htmlFor={id}
                className={[
                  'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border text-sm font-medium select-none transition-colors',
                  'focus-within:ring-2 focus-within:ring-sky-600 focus-within:ring-offset-1',
                  checked
                    ? 'border-sky-600 bg-sky-600 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400',
                  errors.weekdays ? 'border-red-300' : '',
                ].join(' ')}
                title={label}
              >
                <input
                  id={id}
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={() => toggleWeekday(iso)}
                  aria-label={label}
                />
                {short}
              </label>
            );
          })}
        </div>
        {errors.weekdays && (
          <p id="weekdays-error" role="alert" className="mt-1 text-sm text-red-600">
            {errors.weekdays}
          </p>
        )}
      </fieldset>

      {/* Interval */}
      <div className="space-y-1">
        <Label htmlFor="intervalWeeks">
          Repeat every <span aria-hidden="true">*</span>
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="intervalWeeks"
            type="number"
            min={1}
            max={52}
            value={value.intervalWeeks}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({ ...value, intervalWeeks: isNaN(n) ? 1 : Math.max(1, n) });
              onClearError('intervalWeeks');
            }}
            className={['w-20', errors.intervalWeeks ? 'border-red-500' : ''].join(' ')}
            aria-describedby={errors.intervalWeeks ? 'intervalWeeks-error' : undefined}
          />
          <span className="text-sm text-slate-700">week(s)</span>
        </div>
        {errors.intervalWeeks && (
          <p id="intervalWeeks-error" role="alert" className="text-sm text-red-600">
            {errors.intervalWeeks}
          </p>
        )}
      </div>

      {/* End config */}
      <fieldset>
        <legend className="text-sm font-medium text-slate-900 mb-2">
          Ends <span aria-hidden="true">*</span>
        </legend>
        <div className="space-y-3">
          {/* Count option */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="endKind"
              value="count"
              checked={value.end.kind === 'count'}
              onChange={() => setEndKind('count')}
              className="h-4 w-4 border-slate-300 text-sky-600 focus:ring-sky-600"
              aria-label="After a number of occurrences"
            />
            <span className="text-sm text-slate-700">For</span>
            <Input
              id="endCount"
              type="number"
              min={1}
              max={52}
              value={value.end.kind === 'count' ? value.end.count : 4}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({
                  ...value,
                  end: { kind: 'count', count: isNaN(n) ? 1 : Math.min(52, Math.max(1, n)) },
                });
                onClearError('count');
              }}
              disabled={value.end.kind !== 'count'}
              className={['w-20', errors.count ? 'border-red-500' : ''].join(' ')}
              aria-describedby={errors.count ? 'endCount-error' : undefined}
              aria-label="Number of occurrences"
            />
            <span className="text-sm text-slate-700">occurrence(s)</span>
          </label>
          {errors.count && (
            <p id="endCount-error" role="alert" className="text-sm text-red-600 pl-7">
              {errors.count}
            </p>
          )}

          {/* Until date option */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="endKind"
              value="until"
              checked={value.end.kind === 'until'}
              onChange={() => setEndKind('until')}
              className="h-4 w-4 border-slate-300 text-sky-600 focus:ring-sky-600"
              aria-label="Until a specific date"
            />
            <span className="text-sm text-slate-700">Until</span>
            <Input
              id="endUntilDate"
              type="date"
              value={value.end.kind === 'until' ? value.end.untilDate : ''}
              onChange={(e) => {
                onChange({ ...value, end: { kind: 'until', untilDate: e.target.value } });
                onClearError('untilDate');
              }}
              disabled={value.end.kind !== 'until'}
              className={[errors.untilDate ? 'border-red-500' : ''].join(' ')}
              aria-describedby={errors.untilDate ? 'endUntilDate-error' : undefined}
              aria-label="End date"
            />
          </label>
          {errors.untilDate && (
            <p id="endUntilDate-error" role="alert" className="text-sm text-red-600 pl-7">
              {errors.untilDate}
            </p>
          )}
        </div>
      </fieldset>

      {/* Timezone */}
      <div className="space-y-1">
        <Label htmlFor="tz">Timezone</Label>
        <Input
          id="tz"
          type="text"
          value={value.tz}
          onChange={(e) => {
            onChange({ ...value, tz: e.target.value.trim() });
            onClearError('tz');
          }}
          placeholder="e.g. America/Chicago"
          aria-describedby="tz-hint"
          className={errors.tz ? 'border-red-500' : ''}
        />
        <p id="tz-hint" className="text-xs text-slate-500">
          Defaulted from your browser. Confirm if scheduling for a different timezone.
        </p>
        {errors.tz && (
          <p role="alert" className="text-sm text-red-600">
            {errors.tz}
          </p>
        )}
      </div>
    </div>
  );
}
