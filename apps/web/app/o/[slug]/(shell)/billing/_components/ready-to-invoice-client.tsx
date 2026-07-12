/**
 * ready-to-invoice-client.tsx — "Flights ready to invoice" worklist.
 *
 * Lists CLOSED dispatch tickets with no live invoice. For each, the operator
 * picks a rate and clicks Generate — the DRAFT invoice builds itself from the
 * stored Hobbs/flight-time reading (via generateInvoiceFromDispatch), then we
 * navigate to the new draft. billing:manage only (enforced server-side).
 *
 * States: per-row rate select + loading/error; empty; no-rates guidance.
 * MONEY: rate amounts are INTEGER CENTS shown via formatCents. NO Stripe here.
 *
 * BOUNDARY: imports only from '@aeroops/api' types + local actions.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { XCircle, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatCents } from './format-cents';
import {
  generateInvoiceFromDispatchAction,
  type SerializedInvoiceableDispatchRow,
  type RatePickerOption,
} from '../actions';

interface ReadyToInvoiceClientProps {
  slug: string;
  rows: SerializedInvoiceableDispatchRow[];
  rates: RatePickerOption[];
}

const REFUSAL_COPY: Record<string, string> = {
  ticket_not_found: 'That flight could not be found — it may have been changed.',
  ticket_not_closed: 'That flight is no longer closed and cannot be invoiced.',
  rate_not_found: 'The selected rate no longer exists. Pick another rate.',
};

export function ReadyToInvoiceClient({ slug, rows, rates }: ReadyToInvoiceClientProps) {
  const router = useRouter();
  const [selectedRate, setSelectedRate] = React.useState<Record<string, string>>({});
  const [busyTicket, setBusyTicket] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<{ ticketId: string; message: string } | null>(null);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No closed flights are waiting to be invoiced. Check an aircraft back in on the{' '}
        <Link href={`/o/${slug}/schedule/board`} className="text-brand underline underline-offset-2">
          dispatch board
        </Link>{' '}
        to create one.
      </p>
    );
  }

  const noRates = rates.length === 0;

  async function handleGenerate(row: SerializedInvoiceableDispatchRow) {
    const rateScheduleId = selectedRate[row.dispatchTicketId] ?? rates[0]?.id;
    if (!rateScheduleId) return;

    setRowError(null);
    setBusyTicket(row.dispatchTicketId);
    try {
      const result = await generateInvoiceFromDispatchAction(
        {
          dispatchTicketId: row.dispatchTicketId,
          rateScheduleId,
          memberUserId: row.pilotUserId,
        },
        slug,
      );

      if ('error' in result) {
        const message =
          result.error === 'validation'
            ? result.message
            : result.error === 'forbidden' || result.error === 'unauthenticated'
              ? 'You do not have permission to generate invoices.'
              : 'Something went wrong. Please try again.';
        setRowError({ ticketId: row.dispatchTicketId, message });
        return;
      }

      if (!result.ok) {
        setRowError({
          ticketId: row.dispatchTicketId,
          message: REFUSAL_COPY[result.reason] ?? 'Could not generate the invoice.',
        });
        return;
      }

      // Success — go straight to the new DRAFT invoice.
      router.push(`/o/${slug}/billing/${result.invoiceId}`);
    } catch {
      setRowError({
        ticketId: row.dispatchTicketId,
        message: 'Something went wrong. Please try again.',
      });
    } finally {
      setBusyTicket(null);
    }
  }

  return (
    <div className="space-y-3">
      {noRates && (
        <Alert role="status">
          <AlertDescription>
            Define a billing rate first so invoices can price themselves.{' '}
            <Link
              href={`/o/${slug}/billing/catalog`}
              className="text-brand underline underline-offset-2"
            >
              Manage rates
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
      <div className="rounded-md border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm" aria-label="Flights ready to invoice">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                Aircraft
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
                Pilot
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
                Hours
              </th>
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                Rate
              </th>
              <th scope="col" className="px-3 py-2 w-28" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const busy = busyTicket === row.dispatchTicketId;
              const err = rowError?.ticketId === row.dispatchTicketId ? rowError.message : null;
              return (
                <React.Fragment key={row.dispatchTicketId}>
                  <tr className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-3 nums font-semibold text-slate-900">{row.tailNumber}</td>
                    <td className="px-3 py-3 text-slate-600 hidden sm:table-cell">{row.pilotName}</td>
                    <td className="px-3 py-3 text-right nums text-slate-600">
                      {row.flightTimeHours != null ? row.flightTimeHours.toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-3">
                      <select
                        aria-label={`Rate for ${row.tailNumber}`}
                        value={selectedRate[row.dispatchTicketId] ?? rates[0]?.id ?? ''}
                        onChange={(e) =>
                          setSelectedRate((prev) => ({ ...prev, [row.dispatchTicketId]: e.target.value }))
                        }
                        disabled={busy || noRates}
                        className="flex h-9 w-full max-w-[14rem] rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50"
                      >
                        {rates.map((rate) => (
                          <option key={rate.id} value={rate.id}>
                            {rate.name} ({formatCents(rate.amountCents)})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Button
                        size="sm"
                        disabled={busy || noRates}
                        onClick={() => handleGenerate(row)}
                        isLoading={busy}
                      >
                                                    <Receipt className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                            Generate
                          
                      </Button>
                    </td>
                  </tr>
                  {err && (
                    <tr>
                      <td colSpan={5} className="px-3 pb-3">
                        <Alert variant="destructive" role="alert" aria-live="assertive">
                          <XCircle className="h-4 w-4" aria-hidden="true" />
                          <AlertDescription>{err}</AlertDescription>
                        </Alert>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
