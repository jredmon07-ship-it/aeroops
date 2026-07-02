/**
 * notifications/page.tsx — self-service email notification preferences
 * (Slice P1.3).
 *
 * Route: /o/[slug]/notifications
 * Capability gate: app:access — every role holds it. Notification prefs are
 * personal (self-scoped to session.userId inside the API), not role-scoped,
 * so this page is intentionally NOT restricted to a subset of roles like
 * the portal (portal:access) or org settings (org:manage_settings) pages.
 *
 * NOT wired into the primary sidebar NAV_ITEMS (would require every
 * per-role nav-count assertion in lib/__tests__/nav.test.ts to be revised —
 * out of scope for this slice's footprint). Reachable via a small header
 * link (see (shell)/layout.tsx) — same pattern as the future settings
 * surfaces that don't need top-level nav real estate.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { NotificationPrefsCard } from './_components/notification-prefs-card';

interface NotificationsPageProps {
  params: Promise<{ slug: string }>;
}

export default async function NotificationsPage({ params }: NotificationsPageProps) {
  const { slug } = await params;
  const session = await auth();

  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  try {
    requireCapability(session, 'app:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') {
      redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    }
    if (action === 'login') {
      redirect(`/o/${slug}/login`);
    }
    throw err;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tightish text-slate-900">
          Notification settings
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Control which events send you an email.
        </p>
      </div>

      <div className="max-w-2xl">
        <NotificationPrefsCard />
      </div>
    </div>
  );
}
