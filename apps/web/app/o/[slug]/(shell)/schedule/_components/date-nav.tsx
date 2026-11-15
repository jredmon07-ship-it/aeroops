/**
 * date-nav.tsx — Date navigation control bar for the reservations list.
 *
 * Renders Prev / Today / Next buttons + an aria-live date label.
 * Arrow-key shortcuts are implemented via onKeyDown on the toolbar.
 * Uses router.push to update the ?date= query param.
 *
 * `day` is the ?date= calendar day itself ("YYYY-MM-DD"), never a Date: Prev /
 * Next step it by one calendar day and the label formats it as-is
 * (lib/schedule-day.ts), so the label matches the URL in every time zone.
 * Today is the browser's own calendar date at the moment of the click.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { addDays, dayLabel } from '@/lib/schedule-day';
import { toDateInputValue } from '../_utils/format-time';

interface DateNavProps {
  /** The day shown, "YYYY-MM-DD" (the ?date= value). */
  day: string;
  basePath: string;
}

export function DateNav({ day, basePath }: DateNavProps) {
  const router = useRouter();

  const navigate = React.useCallback(
    (d: string) => {
      router.push(`${basePath}?date=${d}`);
    },
    [router, basePath],
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigate(addDays(day, -1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigate(addDays(day, 1));
      }
    },
    [day, navigate],
  );

  return (
    <div
      role="toolbar"
      aria-label="Date navigation"
      className="flex items-center gap-2"
      onKeyDown={handleKeyDown}
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(addDays(day, -1))}
        aria-label="Previous day"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(toDateInputValue(new Date()))}
        aria-label="Go to today"
      >
        Today
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(addDays(day, 1))}
        aria-label="Next day"
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>

      <output
        aria-live="polite"
        className="ml-2 text-sm font-medium text-slate-700 dark:text-slate-300 min-w-[12rem]"
      >
        {dayLabel(day)}
      </output>
    </div>
  );
}
