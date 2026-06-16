/**
 * use-series-preview.ts — Debounced series preview hook.
 *
 * Fires previewSeriesAction with a 400ms debounce when all recurrence fields
 * are complete (weekdays set, end config valid, resources set, date+time set).
 *
 * Returns { state, preview } where state is one of:
 *   'idle'     — input incomplete; no preview fired.
 *   'loading'  — debounce pending or request in-flight.
 *   'populated' — preview returned successfully.
 *   'error'    — network/server/validation error.
 */
'use client';

import { useState, useEffect, useRef } from 'react';
import { previewSeriesAction } from '../../actions';
import type { PreviewSeriesResult } from '@aeroops/api';

export type SeriesPreviewState = 'idle' | 'loading' | 'populated' | 'error';

export interface SeriesPreviewResult {
  state: SeriesPreviewState;
  preview: PreviewSeriesResult | null;
  errorMessage: string | null;
}

export interface UseSeriesPreviewInput {
  /** YYYY-MM-DD — anchor date for deriving default weekday */
  date: string;
  /** HH:MM — start time */
  startTime: string;
  /** HH:MM — end time (determines duration) */
  endTime: string;
  /** Resource ids */
  resourceIds: string[];
  /** ISO weekday numbers (1=Mon..7=Sun), at least one required */
  weekdays: number[];
  /** Repeat every N weeks (≥1) */
  intervalWeeks: number;
  /** End configuration */
  end:
    | { kind: 'count'; count: number }
    | { kind: 'until'; untilDate: string };
  /** IANA timezone */
  tz: string;
  /** Whether repeat is enabled */
  repeatEnabled: boolean;
}

const DEBOUNCE_MS = 400;

function isInputComplete(input: UseSeriesPreviewInput): boolean {
  if (!input.repeatEnabled) return false;
  if (input.date.length !== 10) return false;
  if (input.startTime.length < 4) return false;
  if (input.endTime.length < 4) return false;
  if (input.resourceIds.length === 0) return false;
  if (input.weekdays.length === 0) return false;
  if (input.intervalWeeks < 1) return false;
  if (!input.tz) return false;

  // Parse times to compute duration
  const startAt = new Date(`${input.date}T${input.startTime}:00`);
  const endAt = new Date(`${input.date}T${input.endTime}:00`);
  if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
    return false;
  }

  if (input.end.kind === 'count') {
    if (input.end.count < 1 || input.end.count > 52) return false;
  } else {
    if (!input.end.untilDate || input.end.untilDate.length !== 10) return false;
  }

  return true;
}

export function useSeriesPreview(input: UseSeriesPreviewInput): SeriesPreviewResult {
  const [state, setState] = useState<SeriesPreviewState>('idle');
  const [preview, setPreview] = useState<PreviewSeriesResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Stable key for dependency comparison
  const depsKey = [
    input.date,
    input.startTime,
    input.endTime,
    input.resourceIds.join(','),
    input.weekdays.sort().join(','),
    input.intervalWeeks,
    input.end.kind,
    input.end.kind === 'count' ? input.end.count : input.end.untilDate,
    input.tz,
    input.repeatEnabled,
  ].join('|');

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!isInputComplete(input)) {
      setState('idle');
      setPreview(null);
      setErrorMessage(null);
      return;
    }

    setState('loading');

    const abortCtx = { cancelled: false };
    abortRef.current = abortCtx;

    timerRef.current = setTimeout(async () => {
      const startAt = new Date(`${input.date}T${input.startTime}:00`);
      const endAt = new Date(`${input.date}T${input.endTime}:00`);
      const durationMinutes = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);

      const apiInput = {
        weekdays: input.weekdays,
        intervalWeeks: input.intervalWeeks,
        end: input.end,
        localStartTime: input.startTime,
        durationMinutes,
        tz: input.tz,
        resourceIds: input.resourceIds,
      };

      try {
        const result = await previewSeriesAction(apiInput);
        if (abortCtx.cancelled) return;

        if ('error' in result) {
          setState('error');
          setPreview(null);
          setErrorMessage(
            result.error === 'validation' ? result.message : 'Preview failed. You can still try submitting.',
          );
          return;
        }

        setState('populated');
        setPreview(result as PreviewSeriesResult);
        setErrorMessage(null);
      } catch {
        if (abortCtx.cancelled) return;
        setState('error');
        setPreview(null);
        setErrorMessage('Preview failed. You can still try submitting.');
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortCtx.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  return { state, preview, errorMessage };
}
