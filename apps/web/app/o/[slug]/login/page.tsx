/**
 * app/o/[slug]/login/page.tsx — Login page for a specific operator (org).
 *
 * Server component: resolves the org by slug server-side before rendering.
 *
 * States rendered:
 *   0. ?notice=password-set — a success banner above the form (after a login
 *      link's set-password form)
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
 *
 * This page never redirects, whatever cookie the visitor has. Protected pages
 * send a session the server has ended (e.g. after a password reset) here, and
 * the middleware still sees that cookie as signed in, so redirecting
 * "signed-in" visitors away from this page would loop.
 */
import { resolveOrgForPage } from '@/lib/org';
import { isSignupEnabled } from '@/lib/signup-enabled';
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
  searchParams?: Promise<{ notice?: string | string[] }>;
}

interface DemoLoginEntry {
  email: string;
  label: string;
}

/**
 * Demo orgs whose sign-in card shows shared credentials right on the page, so
 * a visitor landing here from the project site can get in without
 * hunting. Keyed by slug — real operators' login pages never render this
 * block (their slug simply isn't in this registry).
 */
const DEMO_ORG_LOGINS: Record<string, DemoLoginEntry[]> = {
  alpha: [{ email: 'owner@alpha.aero', label: 'Owner' }],
  bravo: [
    { email: 'owner@bravo.aero', label: 'Owner' },
    { email: 'admin@bravo.aero', label: 'Admin' },
    { email: 'member@bravo.aero', label: 'Member' },
  ],
};

export default async function LoginPage({ params, searchParams }: LoginPageProps) {
  const { slug } = await params;
  // ?notice=password-set — arriving from a login link's set-password form.
  const notice = (await searchParams)?.notice;
  const passwordJustSet = notice === 'password-set';
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
  // The hosted demo orgs (slugs 'alpha' and 'bravo', both seeded by
  // db:seed:demo) show their shared credentials right on the sign-in card.
  // Real operators' login pages never render this block (see DEMO_ORG_LOGINS).
  const demoLogins = DEMO_ORG_LOGINS[slug];

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm" role="main">
        <Card>
          <CardHeader className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              Sign in to {org.name}
            </h1>
            <CardDescription>
              Enter your email and password to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {passwordJustSet && (
              <Alert role="status" className="mb-4">
                <AlertDescription>
                  Your password is saved. Sign in with your email and new password.
                </AlertDescription>
              </Alert>
            )}
            {demoLogins && (
              <div className="mb-4 rounded-md border border-sky-200 dark:border-sky-900/50 bg-sky-50 dark:bg-sky-950/40 px-3 py-2.5 text-sm">
                <p className="font-medium text-sky-900 dark:text-sky-200">Live demo — sign in with:</p>
                {demoLogins.length === 1 ? (
                  <p className="mt-1 text-sky-800 dark:text-sky-200">
                    Email: <strong className="font-mono font-semibold">{demoLogins[0]!.email}</strong>
                    <br />
                    Password: <strong className="font-mono font-semibold">demo1234</strong>
                  </p>
                ) : (
                  <div className="mt-1 space-y-0.5 text-sky-800 dark:text-sky-200">
                    {demoLogins.map((l) => (
                      <p key={l.email}>
                        {l.label}: <strong className="font-mono font-semibold">{l.email}</strong>
                      </p>
                    ))}
                    <p>
                      Password: <strong className="font-mono font-semibold">demo1234</strong> for all three.
                    </p>
                  </div>
                )}
                <p className="mt-1.5 text-xs text-sky-700 dark:text-sky-300">
                  Shared demo with fictional sample data — please don&apos;t enter real
                  personal information.
                </p>
              </div>
            )}
            <LoginForm slug={slug} />
            {/* Only offer self-serve signup where ALLOW_SIGNUP=true (off on the demo). */}
            {isSignupEnabled() && (
              <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
                New to AeroOps?{' '}
                <a href="/signup" className="font-medium underline hover:text-slate-700 dark:hover:text-slate-300">
                  Create an operation
                </a>
                .
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
