/**
 * app/o/[slug]/page.tsx — Authenticated org dashboard (empty state, Phase 0).
 *
 * REPLACES the bare slice-0.2 landing page with the Phase 0 DoD dashboard:
 *   - Greets the user by org name.
 *   - Shows a static status banner (org active, Hubs coming later).
 *   - Renders non-interactive placeholder Hub cards (Scheduling, Billing,
 *     Training) with reduced opacity and aria-labels marking them as coming soon.
 *   - Displays a "Locations: N" stat from getDashboardSummary so there is at
 *     least one real, tenant-scoped data point visible.
 *
 * ALL data is org-scoped via session.orgId (JWT-bound, tamper-proof).
 * No actions, no mutations, no fake data.
 *
 * States:
 *   Loading  — handled by loading.tsx (Suspense skeleton)
 *   Populated — the main happy path rendered here
 *   Error    — redirects to no-access if org data is unavailable
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getDashboardSummary } from '@aeroops/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

interface DashboardPageProps {
  params: Promise<{ slug: string }>;
}

// ─── Placeholder Hub card data ────────────────────────────────────────────────
// Non-interactive; no hrefs. They advertise upcoming Hubs only.
const PLACEHOLDER_HUBS = [
  {
    id: 'scheduling',
    label: 'Scheduling',
    description: 'Aircraft and instructor booking, conflict detection, and dispatch.',
  },
  {
    id: 'billing',
    label: 'Billing',
    description: 'Invoicing, Hobbs/Tach-based charges, block time, and Stripe payments.',
  },
  {
    id: 'training',
    label: 'Training',
    description: 'Student syllabus, stage checks, endorsements, and Part 61/141 records.',
  },
] as const;

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { slug } = await params;
  const session = await auth();

  // Middleware guards this, but defend in depth.
  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  // Fetch tenant-scoped dashboard summary (org_id from JWT, never URL).
  let summary: { orgName: string; orgSlug: string; locationCount: number };
  try {
    summary = await getDashboardSummary(session);
  } catch {
    // If the session is valid but the org data is unreachable
    // (e.g. org deleted after session was issued), redirect to no-access.
    redirect(`/o/${slug}/no-access?reason=no_membership`);
  }

  return (
    <div className="space-y-6">
      {/* ── Welcome heading ─────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Welcome to {summary.orgName}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {summary.locationCount === 0
            ? 'No locations configured yet.'
            : `${summary.locationCount} location${summary.locationCount === 1 ? '' : 's'} configured.`}
        </p>
      </div>

      {/* ── Status banner ───────────────────────────────────────────────── */}
      <Alert
        role="status"
        aria-live="polite"
        className="border-sky-200 bg-sky-50 text-sky-800"
      >
        <AlertDescription>
          Your organization is active and ready. Hubs arrive in later phases.
        </AlertDescription>
      </Alert>

      {/* ── Placeholder Hub cards ────────────────────────────────────────── */}
      <section aria-label="Upcoming feature hubs">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-slate-400">
          Coming soon
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PLACEHOLDER_HUBS.map((hub) => (
            <div
              key={hub.id}
              aria-label={`${hub.label} — coming soon`}
              className="opacity-50"
            >
              <Card className="cursor-default select-none">
                <CardHeader>
                  <CardTitle className="text-base">{hub.label}</CardTitle>
                  <CardDescription className="text-xs">
                    {hub.description}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <span className="inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                    Not yet available
                  </span>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
