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
import Link from 'next/link';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { listMemberMessagesAction } from './actions';
import { ComposeClient } from './_components/compose-client';

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
      <div>
        <Link href={`/o/${slug}/settings`} className="text-xs text-slate-500 hover:text-slate-700">
          ← Org settings
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Messages</h1>
        <p className="mt-1 text-sm text-slate-500">
          Send an email announcement to your members — everyone active, or one role. Delivery is best-effort;
          members who opt out of announcements are skipped.
        </p>
      </div>

      <ComposeClient slug={slug} initialHistory={initialHistory} />
    </div>
  );
}
