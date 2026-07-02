/**
 * app/o/[slug]/(shell)/layout.tsx — Authenticated app shell.
 *
 * This layout lives inside the (shell) route group so it ONLY wraps the
 * authenticated pages (dashboard, settings). The route group is invisible
 * to Next.js routing — /o/[slug] still resolves to this group's page.tsx.
 *
 * /o/[slug]/login and /o/[slug]/no-access sit OUTSIDE the (shell) group
 * and therefore are NOT wrapped by this layout — they remain full-page.
 *
 * Provides:
 *   - Sticky top header: org name, user email, role badge, sign-out button.
 *   - Role-filtered sidebar nav (desktop) + Sheet drawer (mobile).
 *   - Main content area that receives {children}.
 *
 * TENANT ISOLATION PROOF:
 *   - orgName is fetched via getSessionOrg(session) — org_id comes from the
 *     signed JWT (session.orgId), never from the URL slug.
 *   - The role badge uses ROLE_LABELS[session.role] — never the raw enum.
 *
 * NAV AUTHZ:
 *   filterNavForSession (a UI/nav predicate) filters items by hasCapability.
 *   The real RBAC gate is requireCapability() in each protected page.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getSessionOrg } from '@aeroops/api';
import { ROLE_LABELS } from '@aeroops/core';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SignOutButton } from '../sign-out-button';
import { MobileNav } from './mobile-nav';
import { filterNavForSession, NAV_ITEMS } from '@/lib/nav';
import { CommandPalette } from './command-palette';
import { AlertsBell } from './alerts-bell';

interface OrgLayoutProps {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}

export default async function OrgShellLayout({
  children,
  params,
}: OrgLayoutProps) {
  const { slug } = await params;
  const session = await auth();

  // Middleware guards this, but defend in depth.
  // (login/no-access are outside this route group and never reach here)
  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  // Fetch org display data — tenant-scoped via RLS (orgId from JWT).
  let orgName = session.slug; // fallback to slug if fetch fails
  try {
    const orgData = await getSessionOrg(session);
    if (orgData) {
      orgName = orgData.name;
    }
  } catch {
    // If getSessionOrg fails (e.g. org deleted since session issued), we
    // still render the shell with the slug as the fallback org identifier.
    // The individual page will detect this and redirect to no-access.
  }

  const roleLabel = ROLE_LABELS[session.role] ?? session.role;

  // UI/nav only — gate enforced by requireCapability() in each protected page.
  const navItems = filterNavForSession(session, NAV_ITEMS, slug);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* ── Top header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="flex h-14 w-full items-center gap-4 px-4 sm:px-6">
          {/* Mobile menu trigger (renders inside the MobileNav client component) */}
          <MobileNav
            items={navItems}
            currentPath={`/o/${slug}`}
            orgName={orgName}
          />

          {/* Org identity — always visible (tenant isolation proof) */}
          <div className="flex items-center gap-2.5">
            {/* Square brand mark — deliberately NOT rounded (architectural). */}
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-sm bg-brand-ink text-[0.8125rem] font-bold leading-none text-white shadow-sm"
            >
              ✈
            </span>
            <span className="text-[0.95rem] font-semibold tracking-tightish text-slate-900 leading-tight">
              {orgName}
            </span>
            <span className="hidden text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-400 sm:inline">
              · AeroOps
            </span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Search trigger + user identity + role */}
          <div className="flex items-center gap-3">
            {/* ⌘K palette trigger — the palette itself mounts once below. */}
            <CommandPalette slug={slug} />

            {/* Alerts bell — mounts once; self-scoped to session user. */}
            <AlertsBell
              slug={slug}
              orgId={session.orgId}
              userId={session.userId}
            />

            {/* Notification email settings — every role holds app:access;
                self-scoped page, intentionally kept out of the primary
                sidebar (see notifications/page.tsx doc comment). */}
            <Link
              href={`/o/${slug}/notifications`}
              className="hidden text-xs font-medium text-slate-500 hover:text-slate-800 sm:block"
            >
              Notifications
            </Link>

            <Separator orientation="vertical" className="h-5" />

            <span className="hidden text-sm text-slate-500 sm:block">
              {session.user.email}
            </span>
            <Badge variant="secondary" aria-label={`Role: ${roleLabel}`}>
              {roleLabel}
            </Badge>
            <Separator orientation="vertical" className="h-5" />
            <SignOutButton slug={slug} />
          </div>
        </div>
      </header>

      {/* ── Body: command-rail sidebar (desktop) + main content ─────────── */}
      <div className="flex w-full flex-1">
        {/* Desktop sidebar — a dark "command rail" (full-height, edge-aligned) */}
        <aside
          className="hidden w-56 shrink-0 flex-col border-r border-white/10 bg-brand-ink md:flex"
          aria-label="Main navigation"
        >
          <nav className="flex-1 px-3 py-5">
            <p className="px-3 pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-white/35">
              Operations
            </p>
            <ul className="space-y-0.5" role="list">
              {navItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={[
                      'group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      'text-slate-300 hover:bg-white/[0.07] hover:text-white',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                    ].join(' ')}
                  >
                    <span className="mr-2.5 h-3.5 w-0.5 shrink-0 rounded-full bg-transparent transition-colors group-hover:bg-brand" />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="border-t border-white/10 px-5 py-3">
            <span className="text-[0.625rem] font-medium uppercase tracking-wide text-white/30">
              Demo build
            </span>
          </div>
        </aside>

        {/* Main content area — centered to a comfortable reading width */}
        <main className="flex-1 px-4 py-7 sm:px-8" id="main-content">
          <div className="mx-auto w-full max-w-screen-xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
