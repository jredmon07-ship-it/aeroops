/**
 * settings/messages/page.tsx — member messaging / announcements (FC-parity).
 *
 * SERVER-SIDE RBAC GATE:
 *   requireCapability(session, 'org:manage_settings') runs first (owner/manager).
 *   Hiding the nav entry point is cosmetic; this gate is the real one.
 *
 * Fetches the sent-message history server-side, then hands the compose surface
 * to the client component. NO money.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { listMemberMessagesAction } from './actions';
import { ComposeClient } from './_components/compose-client';
import { PageHeader } from '@/components/ui/page-header';

interface MessagesPageProps {
  params: Promise<{ slug: string }>;
}

export default async function MessagesPage({ params }: MessagesPageProps) {
  const { slug } = await params;
  const session = await auth();

  try {
    requireCapability(session, 'org:manage_settings');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  const historyResult = await listMemberMessagesAction();
  const initialHistory = 'ok' in historyResult && historyResult.ok ? historyResult.messages : [];

  return (
    <div className="space-y-6">
      <PageHeader
        backHref={`/o/${slug}/settings`}
        backLabel="Org settings"
        title="Messages"
        subtitle={
          <>
            Send an email announcement to your members — everyone active, or one role. Delivery is best-effort;
            members who opt out of announcements are skipped.
          </>
        }
      />

      <ComposeClient slug={slug} initialHistory={initialHistory} />
    </div>
  );
}
