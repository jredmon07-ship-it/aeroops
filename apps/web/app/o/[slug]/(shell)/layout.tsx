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
 *   - Sticky top header: org name, user email, role badge, sign-out button
 *     (below md the account items move into the mobile nav drawer).
 *   - Role-filtered sidebar nav (desktop) + Sheet drawer (mobile).
 *   - Main content area that receives {children}.
 *   - ViewerTimeZoneSync: reports the browser's zone in the aeroops-tz cookie
 *     so every page's days and clock times are the viewer's, not the
 *     server's (UTC on Vercel).
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
import { getSessionOrg, getOrgFieldStatus, getOrgFeatures, getMyAvatar } from '@aeroops/api';
import type { OrgFieldStatusResult } from '@aeroops/api';
import { ROLE_LABELS, ALL_MODULES_ENABLED } from '@aeroops/core';
import type { OrgFeatureFlags } from '@aeroops/core';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { UserAvatar } from '@/components/ui/user-avatar';
import { SignOutButton } from '../sign-out-button';
import { MobileNav } from './mobile-nav';
import { filterNavForSession, NAV_ITEMS } from '@/lib/nav';
import { CommandPalette } from './command-palette';
import { AlertsBell } from './alerts-bell';
import { FieldStatusBar } from './field-status-bar';
import { Toaster } from '@/components/ui/toaster';
import { ThemeToggle } from './theme-toggle';
import { ViewerTimeZoneSync } from './viewer-time-zone-sync';
import { getViewerTimeZone } from '@/lib/viewer-time-zone';

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

  // Ops status bar data — FAIL SOFT: any failure renders the bar with just
  // the clocks (getOrgFieldStatus never surfaces an error state; this catch
  // is defense in depth so a weather outage can never break the shell).
  let fieldStatus: OrgFieldStatusResult | null = null;
  try {
    fieldStatus = await getOrgFieldStatus(session);
  } catch {
    fieldStatus = null;
  }

  // Per-org module toggles (Slice CLUB-MODE) — FAIL SOFT to all-enabled: a
  // read failure must never blank the nav; each module page still gates
  // server-side on its own getOrgFeatures read.
  let enabledModules: OrgFeatureFlags = ALL_MODULES_ENABLED;
  try {
    const features = await getOrgFeatures(session);
    enabledModules = features.features;
  } catch {
    enabledModules = ALL_MODULES_ENABLED;
  }

  // UI/nav only — gate enforced by requireCapability() in each protected page.
  const navItems = filterNavForSession(session, NAV_ITEMS, slug, enabledModules);

  // Signed-in user's own avatar (Slice AVATARS) — FAIL SOFT to null: any
  // failure (or migration 0048 unapplied) renders the header with initials
  // only, never blocks the shell.
  let myAvatarDataUrl: string | null = null;
  try {
    const avatarResult = await getMyAvatar(session);
    myAvatarDataUrl = avatarResult.avatarDataUrl;
  } catch {
    myAvatarDataUrl = null;
  }

  // The zone this request renders days and times in (the aeroops-tz cookie,
  // else the server's own). ViewerTimeZoneSync compares it with the browser's
  // and refreshes once when they differ, for every page in the shell.
  const timeZone = await getViewerTimeZone();

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-800 dark:bg-slate-950">
      {/* ── Top header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 dark:border-slate-800 dark:bg-slate-900/95 dark:supports-[backdrop-filter]:bg-slate-900/80">
        <div className="flex h-14 w-full items-center gap-2 px-4 sm:gap-4 sm:px-6">
          {/* Mobile menu trigger (renders inside the MobileNav client component).
              Below md the drawer also carries the account cluster (Notifications,
              email, role, Sign out) — the header has no room for it there. */}
          <MobileNav
            items={navItems}
            currentPath={`/o/${slug}`}
            orgName={orgName}
            slug={slug}
            email={session.user.email}
            roleLabel={roleLabel}
            avatarSrc={myAvatarDataUrl}
          />

          {/* Org identity — always visible (tenant isolation proof). min-w-0 +
              truncate: a long name shortens instead of widening the header. */}
          <div className="flex min-w-0 items-center gap-2.5">
            {/* Square brand mark — deliberately NOT rounded (architectural). */}
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-brand-ink text-[0.8125rem] font-bold leading-none text-white shadow-sm"
            >
              ✈
            </span>
            <span className="truncate text-[0.95rem] font-semibold tracking-tightish text-slate-900 leading-tight dark:text-slate-100">
              {orgName}
            </span>
            <span className="hidden shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500 lg:inline dark:text-slate-400">
              · AeroOps
            </span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Search trigger + user identity + role */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-3">
            {/* ⌘K palette trigger — the palette itself mounts once below. */}
            <CommandPalette slug={slug} />

            {/* Alerts bell — mounts once; self-scoped to session user. */}
            <AlertsBell
              slug={slug}
              orgId={session.orgId}
              userId={session.userId}
            />

            {/* Light/dark theme switch — persisted per browser by next-themes. */}
            <ThemeToggle />

            {/* Account cluster — md and up. Below md the mobile nav drawer
                shows the same items (see mobile-nav.tsx). */}
            <div className="hidden items-center gap-3 md:flex">
              {/* Notification email settings — every role holds app:access;
                  self-scoped page, intentionally kept out of the primary
                  sidebar (see notifications/page.tsx doc comment). */}
              <Link
                href={`/o/${slug}/notifications`}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              >
                Notifications
              </Link>

              <Separator orientation="vertical" className="h-5" />

              <UserAvatar name={session.user.email} src={myAvatarDataUrl} size="xs" />
              <span className="hidden text-sm text-slate-500 lg:block dark:text-slate-400">
                {session.user.email}
              </span>
              <Badge variant="secondary" aria-label={`Role: ${roleLabel}`}>
                {roleLabel}
              </Badge>
              <Separator orientation="vertical" className="h-5" />
              <SignOutButton slug={slug} />
            </div>
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
            {/* white/50 is the lightest step that clears WCAG AA (5.1:1) on
                the brand-ink rail; /45 is 4.4:1. Same for "Demo build". */}
            <p className="px-3 pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-white/50">
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
            <span className="text-[0.625rem] font-medium uppercase tracking-wide text-white/50">
              Demo build
            </span>
          </div>
        </aside>

        {/* Main content area — centered to a comfortable reading width.
            pb-16 keeps content clear of the fixed bottom status bar.
            min-w-0: a flex item otherwise grows to its widest child, so wide
            tables and the board's time track widened the whole page instead
            of scrolling inside their own overflow-x-auto containers. */}
        <main className="min-w-0 flex-1 px-4 py-7 pb-16 sm:px-8" id="main-content">
          <div className="mx-auto w-full max-w-screen-xl">{children}</div>
        </main>
      </div>

      {/* ── Ops status bar (fixed bottom, every screen) ───────────────────── */}
      <FieldStatusBar status={fieldStatus} />

      {/* ── App-wide toast stack (toast-on-mutation standard) ─────────────── */}
      <Toaster />

      {/* ── Viewer time zone: cookie + one refresh on a zone change ─────────── */}
      <ViewerTimeZoneSync serverTimeZone={timeZone} />
    </div>
  );
}
