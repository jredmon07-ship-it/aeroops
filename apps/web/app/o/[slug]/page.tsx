/**
 * app/o/[slug]/page.tsx — Authenticated org landing page (bare).
 *
 * This is NOT the dashboard — it is the minimal slice-0.2 proof that the
 * session is correctly bound to the org. The full app shell comes in 0.3.
 *
 * Displays:
 *   - Organization name
 *   - User's role (via ROLE_LABELS — never the raw enum)
 *   - User's email address
 *   - "Sign out" button (behind AlertDialog confirm)
 *
 * org.name is fetched via getSessionOrg which uses withOrgContext (RLS scoped
 * to session.orgId). The orgId always comes from the signed JWT — never the URL.
 *
 * Middleware (/middleware.ts) ensures only authenticated users with the correct
 * session.slug reach this page.
 *
 * States:
 *   - Loading:    Next.js Suspense skeleton (handled via loading.tsx)
 *   - Populated:  definition list of org, role, user
 *   - Error:      redirects to no-access if org data is unavailable
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getSessionOrg } from '@aeroops/api';
import { ROLE_LABELS } from '@aeroops/core';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SignOutButton } from './sign-out-button';

interface OrgLandingPageProps {
  params: Promise<{ slug: string }>;
}

export default async function OrgLandingPage({ params }: OrgLandingPageProps) {
  const { slug } = await params;
  const session = await auth();

  // Middleware should catch unauthenticated users, but guard defensively
  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  // Fetch org data (tenant-scoped via RLS, org_id from session JWT)
  const orgData = await getSessionOrg(session);

  // If org data is missing (race condition or session integrity issue), bounce
  if (!orgData) {
    redirect(`/o/${slug}/no-access?reason=no_membership`);
  }

  const roleLabel = ROLE_LABELS[session.role] ?? session.role;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">You&apos;re signed in</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6">
            <dl className="space-y-4 text-sm">
              <div className="flex items-start justify-between gap-4">
                <dt className="font-medium text-slate-500">Organization</dt>
                <dd className="text-right font-semibold text-slate-900">
                  {orgData.name}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="font-medium text-slate-500">Role</dt>
                <dd>
                  <Badge variant="secondary">{roleLabel}</Badge>
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="font-medium text-slate-500">User</dt>
                <dd className="text-right text-slate-900">
                  {session.user.email}
                </dd>
              </div>
            </dl>

            <div className="mt-6 flex justify-end">
              <SignOutButton slug={slug} />
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
