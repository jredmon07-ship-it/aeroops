/**
 * app/o/[slug]/no-access/page.tsx — Permission-denied page for tenant routes.
 *
 * Rendered when a user is authenticated but cannot access the org or a
 * specific page within the org.
 *
 * Reason is conveyed via the `?reason` query param:
 *   - no_membership      — "Your account isn't connected to this operator…"
 *   - org_suspended      — "This operator's account is suspended…"
 *   - insufficient_role  — "You don't have permission to access this page…"
 *                          Also shows a "Back to Dashboard" link.
 *   - module_disabled    — "This area is turned off…" (Slice CLUB-MODE — the
 *                          org has turned off the module this page belongs to).
 *                          Also shows a "Back to Dashboard" link.
 *   - (default)          — generic message
 *
 * Sign-out button is always present and is immediate (no confirm here —
 * the user is already in an error state; no work to lose).
 *
 * Note: this is a PUBLIC route — it must be reachable without a session
 * (e.g. after a session is revoked or org is suspended mid-session).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ImmediateSignOutButton } from './immediate-sign-out-button';

export const metadata: Metadata = {
  title: 'Access Denied — AeroOps',
};

type Reason = 'no_membership' | 'org_suspended' | 'insufficient_role' | string;

const REASON_MESSAGES: Record<string, string> = {
  no_membership:
    "Your account isn't connected to this operator. Contact the operator administrator to request access.",
  org_suspended:
    "This operator's account is suspended. Please contact AeroOps support for assistance.",
  insufficient_role:
    "You don't have permission to access this page. Contact your operator's owner if you need access.",
  module_disabled:
    'An owner or manager can turn it back on in Org settings under Modules.',
};

// Slice CLUB-MODE: module_disabled gets its own card title ("This area is
// turned off") instead of the generic "Access denied" — this isn't a
// permissions problem, the org just switched the module off.
const REASON_TITLES: Record<string, string> = {
  module_disabled: 'This area is turned off',
};

function getReasonMessage(reason: Reason): string {
  return (
    REASON_MESSAGES[reason] ??
    'You do not have permission to access this operator.'
  );
}

function getReasonTitle(reason: Reason): string {
  return REASON_TITLES[reason] ?? 'Access denied';
}

interface NoAccessPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ reason?: string }>;
}

export default async function NoAccessPage({
  params,
  searchParams,
}: NoAccessPageProps) {
  const { slug } = await params;
  const { reason = 'no_membership' } = await searchParams;
  const message = getReasonMessage(reason);
  const title = getReasonTitle(reason);
  const isInsufficientRole = reason === 'insufficient_role';
  const isModuleDisabled = reason === 'module_disabled';

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant={isModuleDisabled ? 'default' : 'destructive'} role="alert" aria-live="polite">
              <AlertDescription>{message}</AlertDescription>
            </Alert>

            {!isModuleDisabled && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                If you believe this is a mistake, contact your operator
                administrator.
              </p>
            )}

            {/* Back to Dashboard link — shown for insufficient_role and
                module_disabled. The user is authenticated but hit a page
                their role can't see, or that the org has turned off. */}
            {(isInsufficientRole || isModuleDisabled) && (
              <div className="pt-1">
                <Button asChild variant="outline" className="w-full">
                  <Link href={`/o/${slug}`}>Back to Dashboard</Link>
                </Button>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <ImmediateSignOutButton slug={slug} />
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
