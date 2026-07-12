/**
 * member-balance-card.tsx — account balance chip on the member detail page.
 *
 * Async server component. Sourced from the EXISTING getMemberBalance read via
 * getMemberBalanceSummaryAction, which fails CLOSED: a viewer without
 * billing:access (or any read error) gets null → this card renders NOTHING,
 * mirroring how the dispatch-preflight balance row hides itself. The caller
 * (member detail page) only mounts this when the viewer holds billing:access,
 * so the fail-closed null is belt-and-suspenders.
 *
 * DISPLAY ONLY: integer cents formatted for display; danger color when the
 * balance is negative (member owes). "View account" links to the full billing
 * account. NO Stripe, NO card/bank data.
 */
import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { getMemberBalanceSummaryAction } from '../actions';
import { formatCents } from '../../billing/_components/format-cents';

interface MemberBalanceCardProps {
  memberUserId: string;
  slug: string;
}

export async function MemberBalanceCard({ memberUserId, slug }: MemberBalanceCardProps) {
  const summary = await getMemberBalanceSummaryAction(memberUserId);

  // Fail-closed: no billing:access (or no account / read error) → hide entirely.
  if (summary === null) return null;

  const { balanceCents, minimumBalanceCents } = summary;
  const isNegative = balanceCents < 0;
  const belowMinimum = minimumBalanceCents > 0 && balanceCents < minimumBalanceCents;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-700">Account balance</h2>
        </div>
        <Link
          href={`/o/${slug}/billing/accounts/${memberUserId}`}
          className="text-xs text-brand hover:text-brand-ink underline-offset-2 hover:underline"
        >
          View account
        </Link>
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <span
          className={`nums text-2xl font-bold leading-none ${isNegative ? 'text-danger' : 'text-slate-900'}`}
        >
          {formatCents(balanceCents)}
        </span>
        {minimumBalanceCents > 0 && (
          <span className="text-xs text-slate-400 nums">
            Minimum {formatCents(minimumBalanceCents)}
          </span>
        )}
      </div>
      {belowMinimum && (
        <p className="text-xs text-amber-700">Below the operator&apos;s configured minimum balance.</p>
      )}
    </div>
  );
}
