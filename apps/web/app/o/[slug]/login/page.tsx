/**
 * app/o/[slug]/login/page.tsx — Login page for a specific operator (org).
 *
 * Server component: resolves the org by slug server-side before rendering.
 *
 * States rendered:
 *   1. unknown-org   — org not found for slug (terminal error, no form)
 *   2. org-suspended — org exists but is not active (terminal error, no form)
 *   3. idle/ready    — org is active; render the credentials form
 *
 * The form itself (submitting, invalid-credentials, generic-error states) is
 * handled client-side in <LoginForm>.
 *
 * Security: org resolution uses withPlatformAdminContext (platform-admin read,
 * slug-keyed, read-only). org_id for all subsequent data reads comes only from
 * the signed JWT — never from the URL.
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
import { LoginForm } from './login-form';

interface LoginPageProps {
  params: Promise<{ slug: string }>;
}

export default async function LoginPage({ params }: LoginPageProps) {
  const { slug } = await params;
  const org = await resolveOrgForPage(slug);

  // ── Unknown org (terminal state — no form) ──────────────────────────────
  if (!org) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm" role="main">
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Operator not found</CardTitle>
            </CardHeader>
            <CardContent>
              <Alert variant="destructive" role="alert">
                <AlertDescription>
                  No operator was found at{' '}
                  <strong className="font-semibold">/o/{slug}</strong>. Check
                  the address and try again.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  // ── Suspended org (terminal state — no form) ────────────────────────────
  if (org.status !== 'active') {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm" role="main">
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">{org.name}</CardTitle>
              <CardDescription>Account suspended</CardDescription>
            </CardHeader>
            <CardContent>
              <Alert variant="destructive" role="alert">
                <AlertDescription>
                  This operator&apos;s account is suspended. Please contact
                  AeroOps support for assistance.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  // ── Active org — render the login form ──────────────────────────────────
  // The hosted demo org (slug 'alpha', seeded by db:seed:demo) shows its
  // shared credentials right on the sign-in card so a prospect landing here
  // from the marketing site can get in without hunting. Real operators'
  // login pages never render this block.
  const isDemoOrg = slug === 'alpha';

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm" role="main">
        <Card>
          <CardHeader className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              Sign in to {org.name}
            </h1>
            <CardDescription>
              Enter your email and password to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isDemoOrg && (
              <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm">
                <p className="font-medium text-sky-900">Live demo — sign in with:</p>
                <p className="mt-1 text-sky-800">
                  Email: <strong className="font-mono font-semibold">owner@alpha.aero</strong>
                  <br />
                  Password: <strong className="font-mono font-semibold">demo1234</strong>
                </p>
                <p className="mt-1.5 text-xs text-sky-700">
                  Shared demo with fictional sample data — please don&apos;t enter real
                  personal information.
                </p>
              </div>
            )}
            <LoginForm slug={slug} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
