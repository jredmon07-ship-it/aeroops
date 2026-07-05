/**
 * app/o/[slug]/(shell)/setup/page.tsx — "Set up your operation" checklist.
 *
 * A guided, encouraging setup surface that scales from a 2-plane flying club to
 * a large academy: the two ESSENTIALS (aircraft + people) are front-and-centre,
 * OPTIONAL depth (base airport, rates, policies, payments) sits below.
 *
 * SERVER-SIDE RBAC GATE:
 *   requireCapability(session, 'org:manage_settings') is called first (setup is
 *   an admin task — owner/manager). A non-admin hitting this URL directly is
 *   redirected to no-access. getOnboardingStatus independently re-checks the
 *   same cap (defense in depth).
 *
 * DATA: getOnboardingStatus(session) — a DERIVED read (no onboarding table).
 *   Each step links to the REAL surface that configures it.
 *
 * States:
 *   Loading           — setup/loading.tsx (Suspense skeleton)
 *   Populated         — checklist + progress
 *   All done          — celebratory "fully set up" panel, checklist stays visible
 *   Forbidden         → redirect no-access?reason=insufficient_role
 *   Unauthenticated   → redirect login
 *
 * BOUNDARY: imports ONLY from @aeroops/api — never @aeroops/db.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Circle, ArrowRight } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, getOnboardingStatus } from '@aeroops/api';
import type { OnboardingStatus, OnboardingStepKey } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface SetupPageProps {
  params: Promise<{ slug: string }>;
}

// ─── Per-step display copy (UI-only; keys come from the API) ───────────────────

interface StepMeta {
  title: string;
  /** One-line description of what this step is for. */
  description: string;
  /** Label for the "do it" link. */
  cta: string;
  /** Path suffix appended to /o/[slug]. */
  href: (slug: string) => string;
  /** Optional secondary link (e.g. bulk import) shown when the step is not done. */
  secondary?: { label: string; href: (slug: string) => string };
  /** Copy shown when count > 0 (done) — {n} is replaced with the count. */
  doneNote: (n: number) => string;
}

const STEP_META: Record<OnboardingStepKey, StepMeta> = {
  aircraft: {
    title: 'Add your aircraft',
    description: 'Add each tail you schedule. You can dispatch as soon as one aircraft exists.',
    cta: 'Go to Fleet',
    href: (slug) => `/o/${slug}/fleet`,
    doneNote: (n) => `${n} aircraft in your fleet`,
  },
  people: {
    title: 'Invite your team',
    description: 'Add members — owners, instructors, dispatchers, renters, and students.',
    cta: 'Go to People',
    href: (slug) => `/o/${slug}/people`,
    secondary: {
      label: 'Import a roster',
      href: (slug) => `/o/${slug}/settings/import`,
    },
    doneNote: (n) => `${n} active member${n === 1 ? '' : 's'} on your roster`,
  },
  base_airport: {
    title: 'Set your base airport',
    description:
      'Add your home-base location and its coordinates so day/night times are accurate.',
    cta: 'Go to Fleet',
    href: (slug) => `/o/${slug}/fleet`,
    doneNote: (n) => `${n} base${n === 1 ? '' : 's'} with coordinates`,
  },
  rates: {
    title: 'Define your rates',
    description: 'Set hourly and flat rates so you can generate invoices later.',
    cta: 'Go to Billing rates',
    href: (slug) => `/o/${slug}/billing/catalog`,
    doneNote: (n) => `${n} rate schedule${n === 1 ? '' : 's'} defined`,
  },
  policies: {
    title: 'Set booking policies',
    description: 'Add per-aircraft rules — max duration, advance limits, and blackout windows.',
    cta: 'Go to Schedule',
    href: (slug) => `/o/${slug}/schedule`,
    doneNote: (n) => `${n} booking polic${n === 1 ? 'y' : 'ies'} set`,
  },
  payments: {
    title: 'Connect payments',
    description: 'Link QuickBooks or Stripe to bill members and export your books.',
    cta: 'Go to Settings',
    href: (slug) => `/o/${slug}/settings`,
    doneNote: (n) => `${n} payment provider${n === 1 ? '' : 's'} connected`,
  },
};

// ─── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Setup progress"
    >
      <div
        className="h-full rounded-full bg-brand transition-all"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

// ─── Step row ──────────────────────────────────────────────────────────────────

function StepRow({
  slug,
  stepKey,
  done,
  count,
}: {
  slug: string;
  stepKey: OnboardingStepKey;
  done: boolean;
  count: number;
  essential: boolean;
}) {
  const meta = STEP_META[stepKey];
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      {/* Status icon */}
      <div className="mt-0.5 shrink-0">
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-brand" aria-hidden="true" />
        ) : (
          <Circle className="h-5 w-5 text-slate-300" aria-hidden="true" />
        )}
        <span className="sr-only">{done ? 'Done' : 'Not done'}</span>
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3
            className={[
              'text-sm font-semibold',
              done ? 'text-slate-500' : 'text-slate-900',
            ].join(' ')}
          >
            {meta.title}
          </h3>
        </div>
        <p className="mt-0.5 text-sm text-slate-500">{meta.description}</p>
        {done ? (
          <p className="mt-1 text-xs font-medium text-brand-ink">{meta.doneNote(count)}</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link
              href={meta.href(slug)}
              className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:text-brand-ink underline-offset-2 hover:underline"
            >
              {meta.cta}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            {meta.secondary && (
              <Link
                href={meta.secondary.href(slug)}
                className="text-sm text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
              >
                {meta.secondary.label}
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Essential / Optional badge */}
      <div className="shrink-0">
        <Badge variant={stepKey === 'aircraft' || stepKey === 'people' ? 'default' : 'secondary'}>
          {stepKey === 'aircraft' || stepKey === 'people' ? 'Essential' : 'Optional'}
        </Badge>
      </div>
    </li>
  );
}

// ─── Step group ────────────────────────────────────────────────────────────────

function StepGroup({
  slug,
  title,
  subtitle,
  steps,
}: {
  slug: string;
  title: string;
  subtitle: string;
  steps: OnboardingStatus['steps'];
}) {
  return (
    <section aria-label={title}>
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-slate-100">
          {steps.map((s) => (
            <StepRow
              key={s.key}
              slug={slug}
              stepKey={s.key}
              done={s.done}
              count={s.count}
              essential={s.essential}
            />
          ))}
        </ul>
      </Card>
    </section>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default async function SetupPage({ params }: SetupPageProps) {
  const { slug } = await params;
  const session = await auth();

  // ── Server-side RBAC gate ─────────────────────────────────────────────────
  try {
    requireCapability(session, 'org:manage_settings');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') {
      redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    }
    if (action === 'login') {
      redirect(`/o/${slug}/login`);
    }
    throw err;
  }

  const status = await getOnboardingStatus(session);

  const essentialSteps = status.steps.filter((s) => s.essential);
  const optionalSteps = status.steps.filter((s) => !s.essential);

  const allDone = status.doneCount === status.totalCount;

  return (
    <div className="max-w-3xl space-y-6">
      {/* ── Heading ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Set up your operation</h1>
        <p className="mt-1 text-sm text-slate-500">
          A short checklist to get your flight operation running. Start with the essentials —
          add optional depth whenever you&apos;re ready.
        </p>
      </div>

      {/* ── Progress summary ────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              {status.essentialDone ? (
                <p className="text-sm font-semibold text-brand-ink">
                  Essentials complete — you can start scheduling.
                </p>
              ) : (
                <p className="text-sm font-semibold text-slate-900">
                  Add your aircraft and team to start scheduling.
                </p>
              )}
              <p className="mt-0.5 text-xs text-slate-500">
                {status.doneCount} of {status.totalCount} steps set up
              </p>
            </div>
            <span
              className="nums text-2xl font-bold text-slate-900"
              aria-hidden="true"
            >
              {status.percentComplete}%
            </span>
          </div>
          <ProgressBar percent={status.percentComplete} />
        </CardContent>
      </Card>

      {/* ── All-done celebratory panel ──────────────────────────────────────── */}
      {allDone && (
        <div
          className="flex items-start gap-3 rounded-md border border-brand/20 bg-brand/5 px-5 py-4"
          role="note"
        >
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-brand-ink">
              Your operation is fully set up.
            </p>
            <p className="mt-0.5 text-sm text-slate-600">
              Everything on the checklist is done. You can revisit any surface below to make changes.
            </p>
          </div>
        </div>
      )}

      {/* ── Essentials ──────────────────────────────────────────────────────── */}
      <StepGroup
        slug={slug}
        title="Essentials"
        subtitle="The minimum to start scheduling and dispatching."
        steps={essentialSteps}
      />

      {/* ── Optional depth ──────────────────────────────────────────────────── */}
      <StepGroup
        slug={slug}
        title="Optional — add depth as you grow"
        subtitle="Useful for larger operations. None of these block scheduling."
        steps={optionalSteps}
      />
    </div>
  );
}
