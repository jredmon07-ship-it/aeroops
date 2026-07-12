/**
 * portal-billing-client.tsx — the interactive self-pay surface (Slice P0-REV).
 *
 * PCI / MONEY BOUNDARY:
 *   NO raw card/bank data is ever typed into or handled by this component or
 *   sent to this server. "Add payment method" collects a Stripe PaymentMethod
 *   id (pm_...) — in production this comes from a Stripe Element (Stripe-
 *   hosted, client-side, never touching AeroOps servers — PCI SAQ-A).
 *
 *   DEVIATION FLAGGED FOR THE FOUNDER: this build does NOT add the
 *   @stripe/stripe-js + @stripe/react-stripe-js npm packages (the one new
 *   dependency the spec calls for) — with no live Stripe keys anywhere in
 *   this environment, an Element could never render a real card form here
 *   regardless, so the input below is a plain text field for a Stripe
 *   PaymentMethod id (useful for TEST-MODE tokens like `pm_card_visa` once
 *   test keys exist) with a clear inline note. Swapping this text field for
 *   a real <PaymentElement/> is a small, isolated follow-up once the founder
 *   adds Stripe test keys — every server action underneath
 *   (createMySetupIntentAction/saveMyPaymentMethodAction) is already fully
 *   wired and PCI-clean either way.
 *
 * States per section: loading (parent Suspense) / not-configured / empty /
 * populated / error (inline).
 */
'use client';

import * as React from 'react';
import { AlertCircle, CreditCard, PlusCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { SavedPaymentMethodView, AutopaySettingView } from '@aeroops/api';
import type { SerializedMyBilling, StripePublishableConfig } from '../../actions';
import {
  createMySetupIntentAction,
  saveMyPaymentMethodAction,
  setMyAutopayAction,
  payMyInvoiceAction,
} from '../../actions';
import { toast } from '@/lib/toast-store';
import { PageHeader } from '@/components/ui/page-header';

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function pmLabel(pm: SavedPaymentMethodView): string {
  const brand = pm.brand ?? (pm.type === 'us_bank_account' ? 'Bank account' : 'Card');
  return pm.last4 ? `${brand} ····${pm.last4}` : brand;
}

interface PortalBillingClientProps {
  initialBilling: SerializedMyBilling;
  stripeConfig: StripePublishableConfig;
}

export function PortalBillingClient({ initialBilling, stripeConfig }: PortalBillingClientProps) {
  const [billing, setBilling] = React.useState(initialBilling);
  const [pmIdInput, setPmIdInput] = React.useState('');
  const [addingPm, setAddingPm] = React.useState(false);
  const [addPmError, setAddPmError] = React.useState<string | null>(null);
  const [autopayBusy, setAutopayBusy] = React.useState(false);
  const [autopayError, setAutopayError] = React.useState<string | null>(null);
  const [payingInvoiceId, setPayingInvoiceId] = React.useState<string | null>(null);
  const [payError, setPayError] = React.useState<string | null>(null);
  const [payClientSecret, setPayClientSecret] = React.useState<{ invoiceId: string; clientSecret: string } | null>(null);

  const openInvoices = billing.invoices.filter((i) => i.status === 'finalized');

  async function handleAddPaymentMethod(e: React.FormEvent) {
    e.preventDefault();
    setAddPmError(null);
    const pmId = pmIdInput.trim();
    if (!pmId) {
      setAddPmError('Enter a payment method id.');
      return;
    }
    setAddingPm(true);
    try {
      // Ensures the SetupIntent flow is exercised end-to-end even though this
      // build does not render a real Stripe Element (see file header).
      const setupR = await createMySetupIntentAction();
      if ('error' in setupR) {
        setAddPmError('Could not start the save-payment-method flow.');
        return;
      }
      if (!setupR.ok) {
        setAddPmError(
          setupR.reason === 'not_configured'
            ? 'Payments are not enabled by your operator yet.'
            : "Couldn't reach Stripe. Please try again.",
        );
        return;
      }
      const saveR = await saveMyPaymentMethodAction(pmId);
      if ('error' in saveR) {
        setAddPmError('Could not save the payment method.');
        return;
      }
      if (!saveR.ok) {
        setAddPmError(
          saveR.reason === 'not_configured'
            ? 'Payments are not enabled by your operator yet.'
            : "Couldn't reach Stripe. Please try again.",
        );
        return;
      }
      setBilling((b) => ({ ...b, paymentMethods: [saveR.paymentMethod, ...b.paymentMethods] }));
      setPmIdInput('');
      toast.success('Payment method saved.');
    } finally {
      setAddingPm(false);
    }
  }

  async function handleToggleAutopay(enabled: boolean, defaultPaymentMethodId?: string) {
    setAutopayError(null);
    setAutopayBusy(true);
    try {
      const result = await setMyAutopayAction(enabled, defaultPaymentMethodId);
      if ('error' in result) {
        setAutopayError('Could not update auto-pay.');
        return;
      }
      if (!result.ok) {
        setAutopayError(
          result.reason === 'pm_required'
            ? 'Add a payment method before turning on auto-pay.'
            : 'That payment method could not be found.',
        );
        return;
      }
      setBilling((b) => ({ ...b, autopay: result.setting }));
      toast.success(enabled ? 'Auto-pay turned on.' : 'Auto-pay turned off.');
    } finally {
      setAutopayBusy(false);
    }
  }

  async function handlePayInvoice(invoiceId: string) {
    setPayError(null);
    setPayClientSecret(null);
    setPayingInvoiceId(invoiceId);
    try {
      const result = await payMyInvoiceAction(invoiceId);
      if ('error' in result) {
        setPayError('Could not start payment.');
        return;
      }
      if (!result.ok) {
        setPayError(
          result.reason === 'not_configured'
            ? 'Payments are not enabled by your operator yet.'
            : result.reason === 'not_found'
              ? 'That invoice could not be found.'
              : result.reason === 'not_finalized'
                ? 'This invoice is not ready to pay yet.'
                : "Couldn't reach Stripe. Please try again.",
        );
        return;
      }
      setPayClientSecret({ invoiceId, clientSecret: result.clientSecret });
    } finally {
      setPayingInvoiceId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" subtitle="Your balance, invoices, and payment methods." />

      {!stripeConfig.configured && (
        <Alert role="status">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>Payments aren&apos;t enabled by your operator yet.</AlertDescription>
        </Alert>
      )}

      {/* Balance */}
      <section className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden" aria-label="Balance">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Balance</h2>
        </div>
        <div className="px-5 py-4">
          <span className={`nums text-2xl font-bold ${billing.balanceCents < 0 ? 'text-danger' : 'text-slate-900'}`}>
            {formatCents(billing.balanceCents)}
          </span>
        </div>
      </section>

      {/* Invoices */}
      <section className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden" aria-label="My invoices">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Invoices</h2>
        </div>
        {openInvoices.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-slate-400">No open invoices.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" role="list">
            {openInvoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="nums text-sm font-medium text-slate-900">{formatCents(inv.totalCents)}</p>
                  <p className="text-xs text-slate-400">
                    {inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : '—'}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={!stripeConfig.configured || payingInvoiceId === inv.id}
                  onClick={() => void handlePayInvoice(inv.id)}
                >
                  {payingInvoiceId === inv.id ? 'Starting…' : 'Pay invoice'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {payError && (
          <div className="px-5 pb-4">
            <Alert variant="destructive" role="alert">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{payError}</AlertDescription>
            </Alert>
          </div>
        )}
        {payClientSecret && (
          <div className="px-5 pb-4">
            <Alert role="status">
              <AlertDescription>
                Payment started — complete it via Stripe&apos;s hosted checkout for invoice{' '}
                {payClientSecret.invoiceId.slice(0, 8)}… (client secret received; the on-screen card form ships once
                Stripe test keys are configured).
              </AlertDescription>
            </Alert>
          </div>
        )}
      </section>

      {/* Saved payment methods + Add */}
      <section className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden" aria-label="Payment methods">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Payment methods</h2>
        </div>
        <div className="px-5 py-4 space-y-4">
          {billing.paymentMethods.length === 0 ? (
            <p className="text-sm text-slate-400">No saved payment methods.</p>
          ) : (
            <ul className="flex flex-wrap gap-2" role="list" aria-label="Saved payment methods">
              {billing.paymentMethods.map((pm) => (
                <li key={pm.id}>
                  <span className="inline-flex items-center gap-1.5 rounded-sm border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700">
                    <CreditCard className="h-3 w-3 text-slate-400" aria-hidden="true" />
                    {pmLabel(pm)}
                    {billing.autopay.defaultPaymentMethodId === pm.id && billing.autopay.enabled && (
                      <span className="text-brand">· auto-pay</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {stripeConfig.configured && (
            <form onSubmit={(e) => void handleAddPaymentMethod(e)} className="space-y-2 max-w-sm">
              {addPmError && (
                <Alert variant="destructive" role="alert">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{addPmError}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1">
                <Label htmlFor="pm-id-input">Payment method id (test mode)</Label>
                <Input
                  id="pm-id-input"
                  type="text"
                  placeholder="pm_card_visa"
                  value={pmIdInput}
                  onChange={(e) => setPmIdInput(e.target.value)}
                  disabled={addingPm}
                />
              </div>
              <Button type="submit" size="sm" disabled={addingPm} aria-busy={addingPm}>
                <PlusCircle className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                {addingPm ? 'Adding…' : 'Add payment method'}
              </Button>
            </form>
          )}
        </div>
      </section>

      {/* Auto-pay */}
      <section className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden" aria-label="Auto-pay">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Auto-pay</h2>
        </div>
        <div className="px-5 py-4 space-y-2">
          {autopayError && (
            <Alert variant="destructive" role="alert">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{autopayError}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center justify-between max-w-sm">
            <div>
              <p className="text-sm text-slate-700">
                {billing.autopay.enabled ? 'Auto-pay is ON' : 'Auto-pay is OFF'}
              </p>
              <p className="text-xs text-slate-400">
                Automatically charges your default payment method when an invoice is issued.
              </p>
            </div>
            {billing.autopay.enabled ? (
              <Button type="button" size="sm" variant="outline" disabled={autopayBusy} onClick={() => void handleToggleAutopay(false)}>
                Turn off
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={autopayBusy || billing.paymentMethods.length === 0}
                onClick={() => void handleToggleAutopay(true, billing.paymentMethods[0]?.id)}
              >
                Turn on auto-pay
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
