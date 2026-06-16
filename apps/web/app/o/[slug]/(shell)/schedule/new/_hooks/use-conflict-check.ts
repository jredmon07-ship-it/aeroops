/**
 * use-conflict-check.ts — Debounced conflict preview hook.
 *
 * Fires checkConflictsAction with a 400ms debounce when date+start+end are
 * set, end > start, and at least one resource is selected.
 *
 * Returns { state, conflicts } where state is one of:
 *   'idle'     — form incomplete; no check fired.
 *   'checking' — debounce pending or request in-flight.
 *   'clear'    — check returned ok:true.
 *   'conflict' — check returned ok:false with conflicts[].
 *   'error'    — network/server error; submit stays enabled.
 */
'use client';

import { useState, useEffect, useRef } from 'react';
import { checkConflictsAction } from '../../actions';
import type { ConflictHit } from '@aeroops/api';

export type ConflictCheckState = 'idle' | 'checking' | 'clear' | 'conflict' | 'error';

export interface ConflictCheckResult {
  state: ConflictCheckState;
  conflicts: ConflictHit[];
}

interface UseConflictCheckInput {
  /** YYYY-MM-DD or empty string */
  date: string;
  /** HH:MM or empty string */
  startTime: string;
  /** HH:MM or empty string */
  endTime: string;
  /** Resource ids to check (may be empty) */
  resourceIds: string[];
}

const DEBOUNCE_MS = 400;

export function useConflictCheck(input: UseConflictCheckInput): ConflictCheckResult {
  const [state, setState] = useState<ConflictCheckState>('idle');
  const [conflicts, setConflicts] = useState<ConflictHit[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { date, startTime, endTime, resourceIds } = input;

  useEffect(() => {
    // Clear pending timer
    if (timerRef.current) clearTimeout(timerRef.current);

    // Check whether input is complete enough to fire
    const hasDate = date.length === 10;
    const hasStart = startTime.length >= 4;
    const hasEnd = endTime.length >= 4;
    const hasResources = resourceIds.length > 0;

    if (!hasDate || !hasStart || !hasEnd || !hasResources) {
      setState('idle');
      setConflicts([]);
      return;
    }

    // Compute actual Date objects
    const startAt = new Date(`${date}T${startTime}:00`);
    const endAt = new Date(`${date}T${endTime}:00`);

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
      setState('idle');
      setConflicts([]);
      return;
    }

    setState('checking');

    timerRef.current = setTimeout(async () => {
      // Abort any in-flight check
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await checkConflictsAction({ startAt, endAt, resourceIds });

        // Ignore if aborted
        if (controller.signal.aborted) return;

        if ('error' in result) {
          setState('error');
          setConflicts([]);
          return;
        }

        if (result.ok) {
          setState('clear');
          setConflicts([]);
        } else {
          setState('conflict');
          setConflicts(result.conflicts);
        }
      } catch {
        if (controller.signal.aborted) return;
        setState('error');
        setConflicts([]);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, startTime, endTime, resourceIds.join(',')]);

  return { state, conflicts };
}
