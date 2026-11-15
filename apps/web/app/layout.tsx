/**
 * app/layout.tsx — Root layout for AeroOps web app.
 *
 * Minimal root layout: loads global CSS (Tailwind + design tokens),
 * sets document metadata and language. No app shell chrome here — that
 * comes in slice 0.3.
 *
 * The ThemeProvider (next-themes) is mounted HERE rather than in the shell so
 * light/dark applies to every page, including the ones outside (shell): login,
 * login links, signup, no-access, the public booking page and the 404.
 *
 * The favicon is app/favicon.ico (+ app/icon.svg), served by Next's file
 * convention: the shell's navy brand mark.
 */
import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'AeroOps',
  description: 'Open-source flight-operations software for flight schools, clubs, and FBOs.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
