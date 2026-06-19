/**
 * auto-scheduler-client.tsx — Client-side orchestrator for the auto-scheduler.
 *
 * Step flow:
 *   1. DemandBuilder (assembles AutoScheduleInput, triggers Preview)
 *   2. PreviewPanel (shows proposals; primary action = "Commit schedule")
 *   3. CommitPanel  (post-commit summary with links to the board)
 *
 * State machine:
 *   'building'    → form is open, no preview yet
 *   'previewing'  → preview call in-flight (loading state in PreviewPanel)
 *   'previewed'   → preview result shown; "Commit schedule" is the next action
 *   'committing'  → commit call in-flight (loading state in commit button)
 *   'committed'   → post-commit summary shown
 *
 * One obvious primary action at each step:
 *   building  → Preview button (in DemandBuilder)
 *   previewed → Commit schedule button (in PreviewPanel)
 *   committed → View on board (in CommitPanel)
 *
 * The commit requires explicit user action — auto-commit is explicitly forbidden
 * by spec §4b.3. The "Commit schedule" button is secondary to Preview and only
 * appears after a successful preview with wouldCreateCount > 0.
 */
'use client';

import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DemandBuilder } from './demand-builder';
import { PreviewPanel } from './preview-panel';
import { CommitPanel } from './commit-panel';
import { previewAutoScheduleAction, runAutoScheduleAction } from '../actions';
import type {
  SerializedPreviewResult,
  SerializedCommitResult,
} from '../actions';
import type { AutoScheduleFormInput } from './demand-builder';
import type { PreviewState } from './preview-panel';
import type { ResourceRow } from '@aeroops/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'building' | 'previewing' | 'previewed' | 'committing' | 'committed';

interface AutoSchedulerClientProps {
  resources: ResourceRow[];
  slug: string;
}

// ─── AutoSchedulerClient ──────────────────────────────────────────────────────

export function AutoSchedulerClient({ resources, slug }: AutoSchedulerClientProps) {
  // ── State ──────────────────────────────────────────────────────────────────
  const [step, setStep] = React.useState<Step>('building');
  const [preview, setPreview] = React.useState<SerializedPreviewResult | null>(null);
  const [committed, setCommitted] = React.useState<SerializedCommitResult | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [commitError, setCommitError] = React.useState<string | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  // The input is saved from preview to reuse on commit
  const [lastInput, setLastInput] = React.useState<AutoScheduleFormInput | null>(null);
  // Confirm dialog before committing
  const [showConfirm, setShowConfirm] = React.useState(false);

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handlePreview(input: AutoScheduleFormInput) {
    setLastInput(input);
    setPreviewError(null);
    setValidationError(null);
    setCommitError(null);
    setStep('previewing');

    const result = await previewAutoScheduleAction(input);

    if ('error' in result) {
      setPreviewError(
        result.error === 'validation'
          ? result.message
          : result.error === 'forbidden'
            ? 'You do not have permission to preview auto-schedule.'
            : result.error === 'unauthenticated'
              ? 'Your session has expired. Please sign in again.'
              : 'Preview failed. Please try again.',
      );
      if (result.error === 'validation') {
        setValidationError(result.message);
      }
      setStep('building');
      return;
    }

    setPreview(result);
    setStep('previewed');
  }

  function handleCommitRequest() {
    // Show explicit confirmation before the destructive commit.
    setShowConfirm(true);
  }

  async function handleConfirmCommit() {
    if (!lastInput) return;
    setShowConfirm(false);
    setCommitError(null);
    setStep('committing');

    const result = await runAutoScheduleAction(lastInput);

    if ('error' in result) {
      setCommitError(
        result.error === 'validation'
          ? result.message
          : result.error === 'forbidden'
            ? 'You do not have permission to commit auto-schedule.'
            : result.error === 'unauthenticated'
              ? 'Your session has expired. Please sign in again.'
              : 'Commit failed. Please try again.',
      );
      // Revert to previewed state so the user can retry or adjust.
      setStep('previewed');
      return;
    }

    setCommitted(result);
    setStep('committed');
  }

  function handleReset() {
    setStep('building');
    setPreview(null);
    setCommitted(null);
    setPreviewError(null);
    setCommitError(null);
    setValidationError(null);
    setLastInput(null);
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  const previewState: PreviewState =
    step === 'previewing'
      ? 'loading'
      : step === 'previewed' || step === 'committing' || step === 'committed'
        ? 'populated'
        : previewError && step === 'building'
          ? 'error'
          : 'idle';

  const isCommitting = step === 'committing';
  const isPreviewing = step === 'previewing';

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* ── Step 1: Demand builder (always shown unless committed) ─────────── */}
      {step !== 'committed' && (
        <DemandBuilder
          resources={resources}
          onPreview={handlePreview}
          isPreviewing={isPreviewing}
          validationError={validationError}
        />
      )}

      {/* Commit error (shown above preview when commit fails) */}
      {commitError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{commitError}</AlertDescription>
        </Alert>
      )}

      {/* ── Step 2: Preview ────────────────────────────────────────────────── */}
      {step !== 'committed' && (
        <PreviewPanel
          state={previewState}
          preview={preview}
          errorMessage={previewError}
          resources={resources}
          onCommit={handleCommitRequest}
          isCommitting={isCommitting}
        />
      )}

      {/* ── Step 3: Commit result ─────────────────────────────────────────── */}
      {step === 'committed' && committed && (
        <CommitPanel
          result={committed}
          resources={resources}
          slug={slug}
          onReset={handleReset}
        />
      )}

      {/* ── Confirm dialog (destructive action guard) ─────────────────────── */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Commit schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create{' '}
              {preview?.wouldCreateCount ?? 0}{' '}
              reservation{(preview?.wouldCreateCount ?? 0) !== 1 ? 's' : ''}{' '}
              on your schedule. Any sessions that conflict with bookings made since
              the preview will be skipped non-fatally. This action cannot be undone
              automatically — use the board to cancel individual reservations if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmCommit}>
              Commit schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
