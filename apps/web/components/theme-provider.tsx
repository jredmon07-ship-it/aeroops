/**
 * theme-provider.tsx — next-themes wrapper for the whole app.
 *
 * Client component (next-themes uses effects + localStorage). Mounted once in
 * the root layout (app/layout.tsx) so light/dark applies to every page: the
 * authenticated shell AND the pages outside it (login, login links, signup,
 * no-access, the public booking page, 404). The switch itself (ThemeToggle)
 * lives in the shell header; the choice is stored per browser, so a signed-out
 * page shows whatever theme the visitor last picked (or the OS preference).
 *
 * Config:
 *   attribute="class"   → toggles the `.dark` class on <html> (matches the
 *                          Tailwind darkMode:'class' + the .dark token block).
 *   defaultTheme="system" + enableSystem → respect the OS preference until the
 *                          user picks a theme via ThemeToggle.
 *
 * <html> carries suppressHydrationWarning (set in the root layout) because
 * next-themes writes the class before React hydrates — its inline script runs
 * at the top of <body>, before any page content paints, so there is no flash.
 */
'use client';

import * as React from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
