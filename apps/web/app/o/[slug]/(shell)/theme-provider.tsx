/**
 * theme-provider.tsx — next-themes wrapper for the authenticated app shell.
 *
 * Client component (next-themes uses effects + localStorage). Mounted once in
 * (shell)/layout.tsx around the shell chrome so light/dark applies app-wide.
 *
 * Config:
 *   attribute="class"   → toggles the `.dark` class on <html> (matches the
 *                          Tailwind darkMode:'class' + the .dark token block).
 *   defaultTheme="system" + enableSystem → respect the OS preference until the
 *                          user picks a theme via ThemeToggle.
 *
 * <html> carries suppressHydrationWarning (set in the root layout) because
 * next-themes writes the class before React hydrates.
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
