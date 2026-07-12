/**
 * app/book/[slug]/page.tsx — Public booking-request page (PB1.3 / ADR-0013).
 *
 * SERVER COMPONENT — resolves the org by slug and renders one of:
 *   1. unknown / suspended org → ONE neutral card
 *      "This operator isn't accepting online requests right now."
 *      (States are MERGED — no enumeration, we do NOT reveal whether the org exists.)
 *   2. active org → the booking-request form with the org name as the heading.
 *      NO fleet list, NO schedule, NO members, NO tenant data beyond the org name.
 *
 * SECURITY (ADR-0013):
 *   - resolveOrgForPage uses resolveOrgBySlug (withPlatformAdminContext) —
 *     the ONLY sanctioned anon DB read, returning {id, name, slug, status} ONLY.
 *   - The org name is the ONLY tenant datum rendered on the public page.
 *   - NO @aeroops/db import — delegates entirely via @aeroops/api through lib/org.ts.
 *   - This page is OUTSIDE /o/[slug]/ so it is NOT under the auth shell / sidebar.
 *   - Middleware explicitly allows /book/* (ADR-0013 comment in middleware.ts).
 *
 * CHROME:
 *   - Centered card on the brand background gradient, matching the login page.
 *   - NO app nav, NO sidebar, NO user session UI.
 */
import { resolveOrgForPage } from '@/lib/org';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { BookRequestForm } from './_components/book-request-form';

interface BookPageProps {
  params: Promise<{ slug: string }>;
}

/** Neutral card message for unknown or suspended orgs (states are merged — no enumeration). */
function UnavailableCard() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      {/* No role="main" here — <main> is already the main landmark; a child div
          with role="main" would create a duplicate landmark. */}
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Not available</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert role="alert">
              <AlertDescription>
                This operator isn&apos;t accepting online requests right now.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

export default async function BookPage({ params }: BookPageProps) {
  const { slug } = await params;
  const org = await resolveOrgForPage(slug);

  // ── Unknown org OR suspended/inactive org → ONE neutral card (no enumeration) ──
  if (!org || org.status !== 'active') {
    return <UnavailableCard />;
  }

  // ── Active org → render the booking-request form ──────────────────────────
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      {/* No role="main" on the wrapper — <main> is already the landmark. */}
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {org.name}
            </h1>
            <CardDescription>
              Submit a booking request and we&apos;ll be in touch to confirm.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BookRequestForm slug={slug} orgName={org.name} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
