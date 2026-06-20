/**
 * book-request-form.tsx — Client component: public booking-request form (PB1.3).
 *
 * WHAT IT DOES:
 *   Collects a booking request from an unauthenticated user and POSTs it to
 *   /api/public/booking/[slug]. This page is a lead-capture surface — NOT an
 *   instant booking.
 *
 * STATES:
 *   idle       — form is ready to fill in
 *   submitting — inputs disabled, spinner on the submit button
 *   success    — thank-you card (echos only what the user typed + org name)
 *   invalid    — inline generic error ("please check your entries…")
 *   unavailable — the operator is no longer accepting requests (neutral card, no enum)
 *
 * SECURITY / ADR-0013:
 *   - slug comes from the parent server component (URL path), NEVER from user input.
 *   - The submit body contains NONE of org_id or slug.
 *   - The thank-you state echoes ONLY the requester's own typed values — no id,
 *     no tenant data, no DB fields.
 *   - The honeypot `website` field is visually hidden, tabIndex={-1}, autoComplete="off".
 *     Real users never see or fill it. The orchestrator silently returns fake success
 *     when it is non-empty.
 *
 * A11Y:
 *   - Every input has an associated <Label>.
 *   - Required fields have aria-required="true" and a visual asterisk.
 *   - Error state alerts use aria-live="assertive" and role="alert".
 *   - The submit button carries aria-busy while submitting.
 *   - Focus is moved to the status region on success.
 */
'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { buildIsoDateTime } from '@/lib/book-request-utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BookRequestFormProps {
  /** Org slug from the URL — comes from the parent server component, NEVER from user input. */
  slug: string;
  /** Org name for display in the thank-you state. */
  orgName: string;
}

/** What the user typed — echoed back verbatim in the thank-you state. */
interface SubmittedValues {
  name: string;
  email: string;
  phone: string;
  requestedDate: string;
  requestedTime: string;
  requestedEndDate: string;
  requestedEndTime: string;
  aircraftTypePref: string;
  message: string;
}

type FormStatus =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; submitted: SubmittedValues }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

// ─── Component ───────────────────────────────────────────────────────────────

export function BookRequestForm({ slug, orgName }: BookRequestFormProps) {
  const [status, setStatus] = React.useState<FormStatus>({ kind: 'idle' });

  // Ref for focus management: move focus into the status region on success/unavailable
  const statusRegionRef = React.useRef<HTMLDivElement>(null);

  // Focus the status region when the form reaches a terminal/non-idle state
  React.useEffect(() => {
    if (status.kind === 'success' || status.kind === 'unavailable') {
      statusRegionRef.current?.focus();
    }
  }, [status.kind]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);

    const name = (formData.get('name') as string).trim();
    const email = (formData.get('email') as string).trim();
    const phone = ((formData.get('phone') as string) ?? '').trim();
    const requestedDate = (formData.get('requestedDate') as string).trim();
    const requestedTime = (formData.get('requestedTime') as string).trim();
    const requestedEndDate = ((formData.get('requestedEndDate') as string) ?? '').trim();
    const requestedEndTime = ((formData.get('requestedEndTime') as string) ?? '').trim();
    const aircraftTypePref = ((formData.get('aircraftTypePref') as string) ?? '').trim();
    const message = ((formData.get('message') as string) ?? '').trim();
    const website = (formData.get('website') as string) ?? '';

    // Client-side required check (server validates fully; this surfaces a quick hint)
    if (!name || !email || !requestedDate) {
      setStatus({ kind: 'invalid' });
      return;
    }

    const requestedStart = buildIsoDateTime(requestedDate, requestedTime);
    if (!requestedStart) {
      setStatus({ kind: 'invalid' });
      return;
    }

    const requestedEnd =
      requestedEndDate
        ? buildIsoDateTime(requestedEndDate, requestedEndTime)
        : undefined;

    setStatus({ kind: 'submitting' });

    const body: Record<string, string | undefined> = {
      name,
      email,
      ...(phone ? { phone } : {}),
      requestedStart,
      ...(requestedEnd ? { requestedEnd } : {}),
      ...(aircraftTypePref ? { aircraftTypePref } : {}),
      ...(message ? { message } : {}),
      // Honeypot included in the body — the orchestrator checks it.
      website,
    };

    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = (await res.json()) as { ok: boolean; reason?: string };

      if (json.ok) {
        setStatus({
          kind: 'success',
          submitted: {
            name,
            email,
            phone,
            requestedDate,
            requestedTime,
            requestedEndDate,
            requestedEndTime,
            aircraftTypePref,
            message,
          },
        });
        return;
      }

      if (json.reason === 'unavailable') {
        setStatus({ kind: 'unavailable' });
        return;
      }

      // reason === 'invalid' or anything else
      setStatus({ kind: 'invalid' });
    } catch {
      // Network failure — surface as generic invalid
      setStatus({ kind: 'invalid' });
    }
  }

  const isSubmitting = status.kind === 'submitting';

  // ── Success state ──────────────────────────────────────────────────────────
  if (status.kind === 'success') {
    const s = status.submitted;
    return (
      <div
        ref={statusRegionRef}
        tabIndex={-1}
        className="space-y-4 focus:outline-none"
        role="status"
        aria-label="Request submitted"
      >
        <Alert className="border-green-200 bg-green-50 text-green-900">
          <AlertDescription>
            <p className="font-medium">Your request has been submitted to {orgName}.</p>
            <p className="mt-1 text-sm text-green-800">
              The operator will contact you to confirm. This is not an instant booking.
            </p>
          </AlertDescription>
        </Alert>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 space-y-1">
          <p><span className="font-medium">Name:</span> {s.name}</p>
          <p><span className="font-medium">Email:</span> {s.email}</p>
          {s.phone && <p><span className="font-medium">Phone:</span> {s.phone}</p>}
          <p>
            <span className="font-medium">Requested date:</span>{' '}
            {s.requestedDate}{s.requestedTime ? ` at ${s.requestedTime}` : ''}
          </p>
          {s.requestedEndDate && (
            <p>
              <span className="font-medium">Requested end:</span>{' '}
              {s.requestedEndDate}{s.requestedEndTime ? ` at ${s.requestedEndTime}` : ''}
            </p>
          )}
          {s.aircraftTypePref && (
            <p><span className="font-medium">Aircraft preference:</span> {s.aircraftTypePref}</p>
          )}
          {s.message && <p><span className="font-medium">Message:</span> {s.message}</p>}
        </div>
      </div>
    );
  }

  // ── Unavailable state ──────────────────────────────────────────────────────
  if (status.kind === 'unavailable') {
    return (
      <div
        ref={statusRegionRef}
        tabIndex={-1}
        className="focus:outline-none"
        role="status"
      >
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            This operator isn&apos;t accepting online requests right now.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // ── Idle / submitting / invalid — render the form ─────────────────────────
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {/* Error alert */}
      {status.kind === 'invalid' && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>
            Please check your entries and try again.
          </AlertDescription>
        </Alert>
      )}

      {/* Disclaimer */}
      <p className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
        This is a request — the operator will contact you to confirm. Not an instant booking.
      </p>

      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor="name">
          Name <span aria-hidden="true" className="text-danger">*</span>
        </Label>
        <Input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          aria-required="true"
          disabled={isSubmitting}
          placeholder="Your full name"
          maxLength={120}
        />
      </div>

      {/* Email */}
      <div className="space-y-1.5">
        <Label htmlFor="email">
          Email <span aria-hidden="true" className="text-danger">*</span>
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-required="true"
          disabled={isSubmitting}
          placeholder="you@example.com"
          maxLength={254}
        />
      </div>

      {/* Phone (optional) */}
      <div className="space-y-1.5">
        <Label htmlFor="phone">
          Phone <span className="text-slate-400 font-normal">(optional)</span>
        </Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          disabled={isSubmitting}
          placeholder="+1 555 000 0000"
          maxLength={40}
        />
      </div>

      {/* Requested date + time */}
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-slate-700">
          Requested date &amp; time <span aria-hidden="true" className="text-danger">*</span>
        </legend>
        <div className="flex gap-3">
          <Input
            id="requestedDate"
            name="requestedDate"
            type="date"
            required
            aria-required="true"
            disabled={isSubmitting}
            className="flex-1"
            aria-label="Requested date"
          />
          <Input
            id="requestedTime"
            name="requestedTime"
            type="time"
            disabled={isSubmitting}
            className="w-36"
            aria-label="Requested time (optional)"
          />
        </div>
      </fieldset>

      {/* Optional end date + time */}
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-slate-700">
          End date &amp; time <span className="text-slate-400 font-normal">(optional)</span>
        </legend>
        <div className="flex gap-3">
          <Input
            id="requestedEndDate"
            name="requestedEndDate"
            type="date"
            disabled={isSubmitting}
            className="flex-1"
            aria-label="End date (optional)"
          />
          <Input
            id="requestedEndTime"
            name="requestedEndTime"
            type="time"
            disabled={isSubmitting}
            className="w-36"
            aria-label="End time (optional)"
          />
        </div>
      </fieldset>

      {/* Aircraft type preference (free-text, optional) */}
      <div className="space-y-1.5">
        <Label htmlFor="aircraftTypePref">
          Aircraft preference <span className="text-slate-400 font-normal">(optional)</span>
        </Label>
        <Input
          id="aircraftTypePref"
          name="aircraftTypePref"
          type="text"
          disabled={isSubmitting}
          placeholder="e.g. C172 or similar"
          maxLength={80}
        />
      </div>

      {/* Message (optional textarea) */}
      <div className="space-y-1.5">
        <Label htmlFor="message">
          Message <span className="text-slate-400 font-normal">(optional)</span>
        </Label>
        <Textarea
          id="message"
          name="message"
          disabled={isSubmitting}
          placeholder="Any other details or questions for the operator…"
          maxLength={2000}
          className="min-h-[100px]"
        />
      </div>

      {/* ── Honeypot (visually hidden; real users never see or fill this) ────── */}
      {/* ADR-0013: non-empty → orchestrator silently returns fake success, no DB write */}
      <div aria-hidden="true" className="absolute -left-[9999px] -top-[9999px] w-px h-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </div>

      {/* Submit */}
      <Button
        type="submit"
        className="w-full"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Sending request…</span>
          </>
        ) : (
          'Send booking request'
        )}
      </Button>
    </form>
  );
}
