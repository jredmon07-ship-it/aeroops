/**
 * app/layout.tsx — Root layout for AeroOps web app.
 *
 * Minimal root layout: loads global CSS (Tailwind + design tokens),
 * sets document metadata and language. No app shell chrome here — that
 * comes in slice 0.3.
 */
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AeroOps',
  description: 'Multi-tenant SaaS for flight schools, clubs, and FBOs.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
