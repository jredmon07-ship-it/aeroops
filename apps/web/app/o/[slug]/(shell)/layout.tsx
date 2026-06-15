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
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex h-14 max-w-screen-xl items-center gap-4 px-4 sm:px-6">
          {/* Mobile menu trigger (renders inside the MobileNav client component) */}
          <MobileNav
            items={navItems}
            currentPath={`/o/${slug}`}
            orgName={orgName}
          />

          {/* Org identity — always visible (tenant isolation proof) */}
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-slate-900 leading-tight">
              {orgName}
            </span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* User identity + role */}
          <div className="flex items-center gap-3">
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

      {/* ── Body: sidebar (desktop) + main content ──────────────────────── */}
      <div className="mx-auto flex w-full max-w-screen-xl flex-1 gap-0">
        {/* Desktop sidebar nav */}
        <aside
          className="hidden w-56 shrink-0 border-r border-slate-200 bg-white md:block"
          aria-label="Main navigation"
        >
          <nav className="px-3 py-4">
            <ul className="space-y-1" role="list">
              {navItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={[
                      'flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      // Active state is handled at the page level via aria-current;
                      // for the static shell we use a hover style only.
                      'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600',
                    ].join(' ')}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        {/* Main content area */}
        <main className="flex-1 px-4 py-6 sm:px-6" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
