/**
 * portal-block-time-client.tsx — read-only self-view of block-time / prepaid
 * packages (Slice B4).
 *
 * READ-ONLY: no writes, no forms — a member cannot buy a block themselves in
 * this slice (staff sells blocks via billing/block-time). NO Stripe, NO
 * card/bank data.
 *
 * States: empty (no purchases yet) / populated.
 */
'use client';

import { Layers } from 'lucide-react';
import type { SerializedMyBlockSummary } from '../../actions';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

interface PortalBlockTimeClientProps {
  summary: SerializedMyBlockSummary;
}

export function PortalBlockTimeClient({ summary }: PortalBlockTimeClientProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Block time"
        subtitle="Your prepaid, discounted hour bundles and remaining balance."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <section className="rounded-md border border-slate-200 bg-white shadow-xs px-5 py-4" aria-label="Hours purchased">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Hours purchased</p>
          <p className="mt-1 nums text-xl font-semibold text-slate-900">{summary.totalHoursPurchased}</p>
        </section>
        <section className="rounded-md border border-slate-200 bg-white shadow-xs px-5 py-4" aria-label="Amount purchased">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Amount purchased</p>
          <p className="mt-1 nums text-xl font-semibold text-slate-900">
            {formatCents(summary.totalAmountPurchasedCents)}
          </p>
        </section>
        <section className="rounded-md border border-slate-200 bg-white shadow-xs px-5 py-4" aria-label="Prepaid balance">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Prepaid balance</p>
          <p className="mt-1 nums text-xl font-semibold text-slate-900">
            {formatCents(summary.prepaidBalanceCents)}
          </p>
        </section>
      </div>

      <section className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden" aria-label="Purchase history">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Purchase history</h2>
        </div>
        {summary.purchases.length === 0 ? (
          <EmptyState icon={Layers} title="No blocks purchased yet." className="py-10" />
        ) : (
          <ul className="divide-y divide-slate-100" role="list">
            {summary.purchases.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="nums text-sm font-medium text-slate-900">
                    {p.hours} hrs / {formatCents(p.amountCents)}
                  </p>
                  <p className="text-xs text-slate-400">{new Date(p.purchasedAt).toLocaleDateString()}</p>
                </div>
                {p.note && <p className="text-xs text-slate-500">{p.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
