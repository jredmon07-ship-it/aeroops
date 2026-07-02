/**
 * app/o/[slug]/settings/import/page.tsx — "Import from Flight Circle"
 * (Slice P1.7).
 *
 * SERVER-SIDE RBAC GATE:
 *   This page covers BOTH import kinds (members + aircraft), each gated by
 *   its OWN capability (people:manage / fleet:manage) at the ACTION layer —
 *   the page itself is reachable by anyone holding EITHER capability (an
 *   OR-gate), and the client only shows the kind(s) the caller can actually
 *   use. A student/renter/cfi/dispatcher/accountant with neither capability
 *   is redirected to no-access. This is a UX convenience — every real write
 *   is independently re-gated server-side by previewImport/commitImport.
 *
 * NO ledger/financial-history import — see docs/specs/slice-p1-fc-import.md.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { can } from '@aeroops/core';
import { ImportClient } from './_components/import-client';

interface ImportPageProps {
  params: Promise<{ slug: string }>;
}

export default async function DataImportPage({ params }: ImportPageProps) {
  const { slug } = await params;
  const session = await auth();

  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  const canMembers = can(session.role, 'people:manage');
  const canAircraft = can(session.role, 'fleet:manage');

  if (!canMembers && !canAircraft) {
    redirect(`/o/${slug}/no-access?reason=insufficient_role`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Import from Flight Circle</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload a CSV export from your previous provider&apos;s Reports → Downloads screen (their &ldquo;Users
          Export&rdquo; for members, or an aircraft list). Review the detected columns and a preview before
          anything is created — nothing is added to your roster or fleet until you confirm.
        </p>
      </div>

      <ImportClient slug={slug} canMembers={canMembers} canAircraft={canAircraft} />
    </div>
  );
}
