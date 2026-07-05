/**
 * app/o/[slug]/settings/page.tsx — Org settings (read-only, Phase 0).
 *
 * SERVER-SIDE RBAC GATE:
 *   requireCapability(session, 'org:manage_settings') is called first.
 *   A student hitting this URL directly is redirected to no-access even
 *   though the nav link is absent. This is the real gate — hiding the nav
 *   link is cosmetic only.
 *
 *   Error handling uses mapAuthErrorToResponse() (pure, unit-testable) to
 *   convert ForbiddenError → 'forbidden' and UnauthenticatedError → 'login',
 *   keeping the redirect mapping decoupled from the error class hierarchy.
 *
 * CONTENT (Phase 0):
 *   Read-only display of org name and slug. No forms, no mutations.
 *
 * States:
 *   Loading           — handled by settings/loading.tsx (Suspense skeleton)
 *   Populated         — read-only org info card
 *   Forbidden         → redirect to no-access?reason=insufficient_role
 *   Unauthenticated   → redirect to login
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';
import { requireCapability, getSessionOrg } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { QboSettingsCard } from './_components/qbo-settings-card';

interface OrgSettingsPageProps {
  params: Promise<{ slug: string }>;
}

export default async function OrgSettingsPage({ params }: OrgSettingsPageProps) {
  const { slug } = await params;
  const session = await auth();

  // ── Server-side RBAC gate ─────────────────────────────────────────────────
  // requireCapability throws ForbiddenError or UnauthenticatedError;
  // mapAuthErrorToResponse converts those to typed redirect actions.
  try {
    requireCapability(session, 'org:manage_settings');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') {
      redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    }
    if (action === 'login') {
      redirect(`/o/${slug}/login`);
    }
    // action === 'rethrow' — unexpected error; propagate to Next.js error boundary
    throw err;
  }

  // ── Fetch org display data ────────────────────────────────────────────────
  // session is non-null here (requireCapability succeeded).
  const orgData = await getSessionOrg(session);

  if (!orgData) {
    // Org row missing despite a valid session → bounce to no-access.
    redirect(`/o/${slug}/no-access?reason=no_membership`);
  }

  return (
    <div className="space-y-6">
      {/* ── Page heading ──────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Org settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          View your organization&apos;s details. Editing will be available in a
          later phase.
        </p>
      </div>

      {/* ── Guided setup entry point ───────────────────────────────────────── */}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Set up your operation</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6 space-y-3">
          <p className="text-sm text-slate-500">
            New here, or still getting configured? Follow a short checklist to add your aircraft,
            invite your team, and turn on optional depth as you grow.
          </p>
          <Button asChild type="button" size="sm">
            <Link href={`/o/${slug}/setup`}>Open setup checklist</Link>
          </Button>
        </CardContent>
      </Card>

      {/* ── Read-only org info card ────────────────────────────────────────── */}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Organization details</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          <dl className="space-y-4 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt className="font-medium text-slate-500">Name</dt>
              <dd className="text-right font-semibold text-slate-900">
                {orgData.name}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="font-medium text-slate-500">Slug</dt>
              <dd className="text-right font-mono text-slate-700">
                {orgData.slug}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="font-medium text-slate-500">Status</dt>
              <dd className="text-right text-slate-700 capitalize">
                {orgData.status}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* ── QuickBooks Online integration card (Slice QB1) ────────────────── */}
      <div className="max-w-2xl">
        <QboSettingsCard slug={slug} />
      </div>

      {/* ── Flight Circle data importer (Slice P1.7) ───────────────────────── */}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Import from Flight Circle</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6 space-y-3">
          <p className="text-sm text-slate-500">
            Migrating off another provider? Upload a members or aircraft export CSV — review a preview before
            anything is created.
          </p>
          <Button asChild type="button" size="sm">
            <Link href={`/o/${slug}/settings/import`}>Import data</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
