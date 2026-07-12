/**
 * theme-toggle.tsx — sun/moon light/dark switch for the shell header.
 *
 * Cycles the resolved theme between light and dark (persisted by next-themes).
 * Uses the mounted-flag pattern (same as field-status-bar's clocks): until the
 * component has mounted we render a static placeholder icon so the server and
 * first client render match — next-themes can only know the resolved theme
 * after hydration, so reading it during SSR would trip a hydration mismatch.
 *
 * A11y: a single button with an aria-label that names the action AND the
 * current state (e.g. "Switch to dark theme"); the icon is decorative.
 */
'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { cn } from '@/components/ui/utils';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  const buttonClass = cn(
    'flex h-8 w-8 items-center justify-center rounded-md',
    'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800',
    'dark:text-slate-500 dark:hover:text-slate-200 dark:hover:bg-slate-800',
    'transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900',
  );

  // Pre-mount placeholder: render the Sun statically (no theme knowledge) so
  // SSR and first client paint agree; it's inert until mounted resolves.
  if (!mounted) {
    return (
      <button type="button" className={buttonClass} aria-label="Toggle theme" disabled>
        <Sun className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={buttonClass}
    >
      {isDark ? (
        <Moon className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Sun className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
