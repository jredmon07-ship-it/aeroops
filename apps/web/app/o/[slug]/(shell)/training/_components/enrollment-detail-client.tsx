/**
 * enrollment-detail-client.tsx — Core enrollment detail view (Slice T1.3).
 *
 * Renders:
 *   - Student + course header with status chip
 *   - Progress summary (completed/total + percent bar), labeled "operator progress"
 *     [VERIFY-T1-B]: NOT a regulatory completion
 *   - Per-lesson checklist (completed ✓/not, instructor/completed_at/grade/notes)
 *   - Full record log (voided records struck-through [VERIFY-T1-C])
 *   - Status controls: Complete / Withdraw → setEnrollmentStatus (manage only)
 *   - Record lesson dialog (manage only)
 *   - Void record dialog (confirm + required reason) (manage only)
 *
 * [VERIFY-T1-A]: grade_label = FREE-TEXT, NOT computed ACS/Part-61/141.
 * [VERIFY-T1-B]: progress % = content-coverage, NOT Part-141 determination.
 * [VERIFY-T1-C]: lesson_record = DATA ENTRY, NOT e-signature.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2, Circle, XCircle, Loader2, AlertTriangle,
  ClipboardList, BookOpen, PenLine, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import type {
  SerializedEnrollmentDetail,
  SerializedLessonRecordView,
  SerializedLessonSignatureView,
} from '../actions';
import {
  setEnrollmentStatusAction,
  recordLessonAction,
  voidLessonRecordAction,
  signLessonRecordAction,
  voidLessonSignatureAction,
  getLessonSignaturesAction,
} from '../actions';
import { listMembersAction } from '../../people/actions';
import {
  enrollmentStatusLabel,
  formatProgress,
  formatDateTime,
  formatDate,
} from './training-utils';

// ─── Status chip ───────────────────────────────────────────────────────────────

function EnrollmentStatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-brand-ink">
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span
        className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800"
        title="Operator content flag — not a regulatory completion [VERIFY-T1-B]"
      >
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  if (status === 'withdrawn') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  return <span className="text-xs text-slate-400">{status}</span>;
}

// ─── Progress bar ──────────────────────────────────────────────────────────────
// [VERIFY-T1-B]: content-coverage indicator ONLY.

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      className="h-2 w-full rounded-full bg-slate-100 overflow-hidden"
      role="presentation"
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full bg-brand transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

// ─── Record Lesson Dialog ──────────────────────────────────────────────────────

interface RecordLessonDialogProps {
  enrollmentId: string;
  lessonProgress: SerializedEnrollmentDetail['lessonProgress'];
  onSuccess: (enrollment: SerializedEnrollmentDetail) => void;
}

interface MemberOption {
  userId: string;
  displayName: string;
  email: string;
}

interface RecordLessonFieldErrors {
  lessonId?: string;
  instructorUserId?: string;
}

function RecordLessonDialog({ enrollmentId, lessonProgress, onSuccess }: RecordLessonDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [lessonId, setLessonId] = React.useState('');
  const [instructorUserId, setInstructorUserId] = React.useState('');
  const [gradeLabel, setGradeLabel] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [completedAt, setCompletedAt] = React.useState('');
  const [members, setMembers] = React.useState<MemberOption[]>([]);
  const [loadingMembers, setLoadingMembers] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<RecordLessonFieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function resetForm() {
    setLessonId('');
    setInstructorUserId('');
    setGradeLabel('');
    setNotes('');
    setCompletedAt('');
    setFieldErrors({});
    setDialogError(null);
  }

  React.useEffect(() => {
    if (open) {
      resetForm();
      setLoadingMembers(true);
      listMembersAction({ includeInactive: false })
        .then((result) => {
          if (result && 'ok' in result && result.ok) {
            setMembers(
              result.members.map((m) => ({
                userId: m.userId,
                displayName: m.displayName || m.email,
                email: m.email,
              })),
            );
          } else {
            setMembers([]);
          }
        })
        .catch(() => setMembers([]))
        .finally(() => setLoadingMembers(false));
    }
  }, [open]);

  function validate(): boolean {
    const errors: RecordLessonFieldErrors = {};
    if (!lessonId) errors.lessonId = 'Please select a lesson.';
    if (!instructorUserId) errors.instructorUserId = 'Please select an instructor.';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const result = await recordLessonAction({
        enrollmentId,
        lessonId,
        instructorUserId,
        gradeLabel: gradeLabel.trim() || undefined,
        notes: notes.trim() || undefined,
        completedAt: completedAt || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to record lessons.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'lesson_not_in_course') {
          setFieldErrors((p) => ({ ...p, lessonId: 'This lesson does not belong to the enrollment\'s course.' }));
          return;
        }
        if (result.reason === 'enrollment_not_active') {
          setDialogError('This enrollment is not active. Only active enrollments can receive lesson records.');
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Enrollment or instructor not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess(result.enrollment);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm">
        <ClipboardList className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Record lesson
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record lesson completion</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            {/* Lesson picker (required) */}
            <div className="space-y-1.5">
              <Label htmlFor="rl-lesson">
                Lesson <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              <select
                id="rl-lesson"
                value={lessonId}
                onChange={(e) => {
                  setLessonId(e.target.value);
                  setFieldErrors((p) => ({ ...p, lessonId: undefined }));
                }}
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={fieldErrors.lessonId ? 'true' : undefined}
                aria-describedby={fieldErrors.lessonId ? 'rl-lesson-err' : undefined}
                className={`flex h-10 w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors ${fieldErrors.lessonId ? 'border-red-500' : 'border-slate-300'}`}
              >
                <option value="">Select a lesson…</option>
                {lessonProgress.map((lp) => (
                  <option key={lp.lessonId} value={lp.lessonId}>
                    {lp.position + 1}. {lp.title}{lp.stageLabel ? ` (${lp.stageLabel})` : ''}
                  </option>
                ))}
              </select>
              {fieldErrors.lessonId && (
                <p id="rl-lesson-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.lessonId}
                </p>
              )}
            </div>

            {/* Instructor picker (required) */}
            {/* [VERIFY-T1-C]: NOT an e-signature; [VERIFY-T1-E]: ANY member */}
            <div className="space-y-1.5">
              <Label htmlFor="rl-instructor">
                Instructor <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              {loadingMembers ? (
                <div className="flex items-center gap-2 h-10 px-3 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading members…
                </div>
              ) : (
                <select
                  id="rl-instructor"
                  value={instructorUserId}
                  onChange={(e) => {
                    setInstructorUserId(e.target.value);
                    setFieldErrors((p) => ({ ...p, instructorUserId: undefined }));
                  }}
                  disabled={isSubmitting}
                  aria-required="true"
                  aria-invalid={fieldErrors.instructorUserId ? 'true' : undefined}
                  aria-describedby={fieldErrors.instructorUserId ? 'rl-instr-err' : undefined}
                  className={`flex h-10 w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors ${fieldErrors.instructorUserId ? 'border-red-500' : 'border-slate-300'}`}
                >
                  <option value="">Select an instructor…</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName} — {m.email}
                    </option>
                  ))}
                </select>
              )}
              {fieldErrors.instructorUserId && (
                <p id="rl-instr-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.instructorUserId}
                </p>
              )}
              <p className="text-xs text-slate-400">
                Data entry only — not a regulatory sign-off or e-signature.
              </p>
            </div>

            {/* Completed at (optional, defaults to now) */}
            <div className="space-y-1.5">
              <Label htmlFor="rl-completed-at">Completed at (optional — defaults to now)</Label>
              <Input
                id="rl-completed-at"
                type="datetime-local"
                value={completedAt}
                onChange={(e) => setCompletedAt(e.target.value)}
                disabled={isSubmitting}
              />
            </div>

            {/* Grade label (optional) — FREE-TEXT [VERIFY-T1-A] */}
            <div className="space-y-1.5">
              <Label htmlFor="rl-grade">Grade / label (optional)</Label>
              <Input
                id="rl-grade"
                value={gradeLabel}
                onChange={(e) => setGradeLabel(e.target.value)}
                placeholder="e.g. Satisfactory, Needs review…"
                disabled={isSubmitting}
              />
              <p className="text-xs text-slate-400">
                Free-text operator label — not a computed ACS/Part-61/141 verdict.
              </p>
            </div>

            {/* Notes (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="rl-notes">Notes (optional)</Label>
              <textarea
                id="rl-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional instructor notes…"
                rows={3}
                disabled={isSubmitting}
                className="flex min-h-[80px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 resize-none transition-colors"
              />
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isSubmitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isSubmitting || loadingMembers}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />
                    Recording…
                  </>
                ) : (
                  'Record lesson'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Void Record Dialog ────────────────────────────────────────────────────────

interface VoidRecordDialogProps {
  record: SerializedLessonRecordView;
  onSuccess: (enrollment: SerializedEnrollmentDetail) => void;
}

function VoidRecordDialog({ record, onSuccess }: VoidRecordDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setReasonError(null);
      setDialogError(null);
    }
  }, [open]);

  async function handleConfirm() {
    setDialogError(null);
    setReasonError(null);

    if (!reason.trim()) {
      setReasonError('A void reason is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await voidLessonRecordAction({
        recordId: record.id,
        voidedReason: reason.trim(),
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setReasonError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to void records.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'already_voided') {
          setDialogError('This record has already been voided.');
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Record not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess(result.enrollment);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-slate-400 hover:text-danger hover:bg-danger/5 text-xs"
        aria-label="Void this record"
      >
        Void
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Void lesson record</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <p className="text-sm text-slate-700">
              Voiding marks this record as invalid. The record remains visible for audit
              purposes (struck-through) and cannot be deleted.
            </p>

            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="vr-reason">
                Reason for voiding <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              <Input
                id="vr-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(null);
                }}
                placeholder="e.g. Entered in error, incorrect instructor…"
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={reasonError ? 'true' : undefined}
                aria-describedby={reasonError ? 'vr-reason-err' : undefined}
                className={reasonError ? 'border-red-500' : ''}
              />
              {reasonError && (
                <p id="vr-reason-err" role="alert" className="text-xs text-red-600">
                  {reasonError}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />
                  Voiding…
                </>
              ) : (
                'Void record'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── E-signature panel (Slice P2-ESIGN) ────────────────────────────────────────
//
// COMPLIANCE HARD LINE [VERIFY-P2-A]: a lesson_signature is an operator/
// instructor ATTESTATION artifact — a record of who signed, when, what they
// attested to, and a content hash of the signed lesson_record snapshot. It is
// NOT an FAA-recognized digital/electronic signature, NOT a §61.51 / §61.65 /
// Part-141 endorsement of record, and it computes NO training-completion,
// stage, graduation, or currency determination of any kind. A stored
// signature does not verify eligibility, endorsement validity, or
// airworthiness — a human still makes every regulatory call.

const ESIGN_DISCLAIMER_FULL =
  'A signature here is an operator/instructor ATTESTATION artifact — a record of who signed, ' +
  'when, what they attested to, and a content hash of the signed lesson record snapshot. It is ' +
  'NOT an FAA-recognized digital/electronic signature, NOT a §61.51 / §61.65 / Part-141 ' +
  'endorsement of record, and it computes NO training-completion, stage, graduation, or ' +
  'currency determination of any kind. A stored signature does not verify eligibility, ' +
  'endorsement validity, or airworthiness — a human still makes every regulatory call.';

const ESIGN_DISCLAIMER_SHORT =
  'This is an operator/instructor attestation — NOT an FAA-recognized digital/electronic ' +
  'signature or a §61/§141 endorsement of record. It computes no training-completion, stage, ' +
  'or currency determination.';

interface SignLessonDialogProps {
  lessonRecordId: string;
  onSuccess: (signatures: SerializedLessonSignatureView[]) => void;
}

function SignLessonDialog({ lessonRecordId, onSuccess }: SignLessonDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [attestationText, setAttestationText] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setAttestationText('');
      setFieldError(null);
      setDialogError(null);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    setFieldError(null);

    if (!attestationText.trim()) {
      setFieldError('An attestation statement is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await signLessonRecordAction({
        lessonRecordId,
        attestationText: attestationText.trim(),
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setFieldError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to sign lesson records.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'already_signed') {
          setDialogError('This record already has an active signature.');
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Lesson record not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess(result.signatures);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-xs"
      >
        <PenLine className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
        Sign
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sign lesson record</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            <Alert className="border-slate-200 bg-slate-50" role="note">
              <ShieldCheck className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <AlertDescription className="text-xs text-slate-600">
                {ESIGN_DISCLAIMER_FULL}
              </AlertDescription>
            </Alert>

            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="sl-attestation">
                Attestation statement <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              <textarea
                id="sl-attestation"
                value={attestationText}
                onChange={(e) => {
                  setAttestationText(e.target.value);
                  setFieldError(null);
                }}
                placeholder="e.g. I attest this lesson was conducted as described in this record."
                rows={3}
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={fieldError ? 'true' : undefined}
                aria-describedby={fieldError ? 'sl-attestation-err' : undefined}
                className={`flex min-h-[80px] w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 resize-none transition-colors ${fieldError ? 'border-red-500' : 'border-slate-300'}`}
              />
              {fieldError && (
                <p id="sl-attestation-err" role="alert" className="text-xs text-red-600">
                  {fieldError}
                </p>
              )}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isSubmitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />
                    Signing…
                  </>
                ) : (
                  'Sign record'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface VoidSignatureDialogProps {
  signatureId: string;
  onSuccess: (signatures: SerializedLessonSignatureView[]) => void;
}

function VoidSignatureDialog({ signatureId, onSuccess }: VoidSignatureDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setReasonError(null);
      setDialogError(null);
    }
  }, [open]);

  async function handleConfirm() {
    setDialogError(null);
    setReasonError(null);

    if (!reason.trim()) {
      setReasonError('A void reason is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await voidLessonSignatureAction({
        signatureId,
        reason: reason.trim(),
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setReasonError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to void signatures.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'already_voided') {
          setDialogError('This signature has already been voided.');
          return;
        }
        if (result.reason === 'cannot_void_tombstone') {
          setDialogError('A void record cannot itself be voided.');
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Signature not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess(result.signatures);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-slate-400 hover:text-danger hover:bg-danger/5 text-xs"
        aria-label="Void this signature"
      >
        Void signature
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Void signature</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <p className="text-sm text-slate-700">
              Voiding appends a new tombstone entry — the original signature is never edited or
              deleted, only marked voided.
            </p>

            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="vs-reason">
                Reason for voiding <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              <Input
                id="vs-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(null);
                }}
                placeholder="e.g. Signed the wrong record…"
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={reasonError ? 'true' : undefined}
                aria-describedby={reasonError ? 'vs-reason-err' : undefined}
                className={reasonError ? 'border-red-500' : ''}
              />
              {reasonError && (
                <p id="vs-reason-err" role="alert" className="text-xs text-red-600">
                  {reasonError}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleConfirm} disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />
                  Voiding…
                </>
              ) : (
                'Void signature'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface SignaturePanelProps {
  lessonRecordId: string;
  canManage: boolean;
}

/**
 * SignaturePanel — per-record e-signature status + actions (Slice P2-ESIGN).
 *
 * States: loading (spinner after ~200ms) / error (Alert + Retry) / empty
 * ("Not signed." + Sign button when canManage) / active (Signed badge +
 * details + Void action) / voided (struck-through + Voided chip + Sign
 * button reappears since re-signing is allowed).
 */
function SignaturePanel({ lessonRecordId, canManage }: SignaturePanelProps) {
  const [signatures, setSignatures] = React.useState<SerializedLessonSignatureView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showSpinner, setShowSpinner] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await getLessonSignaturesAction({ lessonRecordId });
      if ('error' in result) {
        setError(
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to view signatures.'
            : 'Could not load signatures.',
        );
        return;
      }
      setSignatures(result.signatures);
    } catch {
      setError('Could not load signatures.');
    }
  }, [lessonRecordId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Loading spinner only after ~200ms to avoid flicker on fast responses.
  React.useEffect(() => {
    if (signatures !== null || error) {
      setShowSpinner(false);
      return;
    }
    const t = setTimeout(() => setShowSpinner(true), 200);
    return () => clearTimeout(t);
  }, [signatures, error]);

  if (error) {
    return (
      <div className="flex items-center gap-2">
        <Alert variant="destructive" role="alert" aria-live="assertive" className="py-1.5 px-2.5">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" className="text-xs" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (signatures === null) {
    return showSpinner ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading…
      </span>
    ) : null;
  }

  const active = signatures.find((s) => !s.isTombstone && !s.isVoided) ?? null;
  const voidedOriginal = signatures.find((s) => !s.isTombstone && s.isVoided) ?? null;
  const tombstone = voidedOriginal
    ? signatures.find((s) => s.voidedBySignatureId === voidedOriginal.id) ?? null
    : null;

  return (
    <div className="space-y-1.5">
      {active && (
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center gap-1 rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-700"
              title="Operator/instructor attestation — not an FAA-recognized signature. [VERIFY-P2-A]"
            >
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Signed
            </span>
            {canManage && (
              <VoidSignatureDialog signatureId={active.id} onSuccess={setSignatures} />
            )}
          </div>
          <p className="text-xs text-slate-400">
            {active.signerName} ({active.roleAtSigning}) · {formatDateTime(active.signedAt)}
          </p>
          <p
            className="nums text-[10px] text-slate-300 truncate max-w-[220px]"
            title="Tamper-evidence digest — not an FAA signature. [VERIFY-P2-A]"
          >
            {active.contentHash.slice(0, 16)}…
          </p>
        </div>
      )}

      {!active && voidedOriginal && (
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="line-through text-xs text-slate-400">
              {voidedOriginal.signerName} ({voidedOriginal.roleAtSigning})
            </span>
            <span className="inline-flex items-center rounded-sm border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-red-700">
              Voided
            </span>
          </div>
          {tombstone && (
            <p className="text-xs text-slate-400">
              by {tombstone.signerName} · {formatDateTime(tombstone.signedAt)} — {tombstone.attestationText}
            </p>
          )}
          {canManage && (
            <SignLessonDialog lessonRecordId={lessonRecordId} onSuccess={setSignatures} />
          )}
        </div>
      )}

      {!active && !voidedOriginal && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-400 italic">Not signed.</span>
          {canManage && (
            <SignLessonDialog lessonRecordId={lessonRecordId} onSuccess={setSignatures} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Status controls ───────────────────────────────────────────────────────────
// Only active enrollments can be transitioned.

interface StatusControlsProps {
  enrollmentId: string;
  status: string;
  onSuccess: (enrollment: SerializedEnrollmentDetail) => void;
}

function StatusControls({ enrollmentId, status, onSuccess }: StatusControlsProps) {
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<string | null>(null); // 'completed' | 'withdrawn'
  const [confirmTarget, setConfirmTarget] = React.useState<string | null>(null); // 'completed' | 'withdrawn'

  if (status !== 'active') return null;

  async function handleTransition(target: string) {
    setDialogError(null);
    setSubmitting(target);
    setConfirmTarget(null);
    try {
      const result = await setEnrollmentStatusAction({ enrollmentId, status: target });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to change enrollment status.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'invalid_transition') {
          setDialogError('This status transition is not allowed.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      onSuccess(result.enrollment);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(null);
    }
  }

  const isCompleting = submitting === 'completed';
  const isWithdrawing = submitting === 'withdrawn';

  return (
    <div className="space-y-2">
      {dialogError && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{dialogError}</AlertDescription>
        </Alert>
      )}

      {confirmTarget === 'completed' && (
        <Alert className="border-green-200 bg-green-50" role="alert">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span className="text-sm text-green-800">
              Mark this enrollment as completed? This is an operator flag — NOT a regulatory determination.
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmTarget(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => handleTransition('completed')}
                disabled={isCompleting}
                className="bg-green-700 hover:bg-green-800 text-white"
              >
                {isCompleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  'Confirm complete'
                )}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {confirmTarget === 'withdrawn' && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span className="text-sm">
              Withdraw this enrollment? This cannot be undone (no re-enrollment).
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmTarget(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => handleTransition('withdrawn')}
                disabled={isWithdrawing}
              >
                {isWithdrawing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  'Confirm withdraw'
                )}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {!confirmTarget && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmTarget('completed')}
            disabled={!!submitting}
            className="border-green-200 text-green-800 hover:bg-green-50"
          >
            Mark completed
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmTarget('withdrawn')}
            disabled={!!submitting}
            className="border-red-200 text-red-700 hover:bg-red-50"
          >
            Withdraw
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main client component ─────────────────────────────────────────────────────

interface EnrollmentDetailClientProps {
  enrollment: SerializedEnrollmentDetail;
  slug: string;
  canManage: boolean;
}

export function EnrollmentDetailClient({
  enrollment: initialEnrollment,
  slug,
  canManage,
}: EnrollmentDetailClientProps) {
  const [enrollment, setEnrollment] = React.useState(initialEnrollment);

  const pr = enrollment.progressRatio;

  return (
    <div className="space-y-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-slate-500">
            Enrollment for{' '}
            <a
              href={`/o/${slug}/training/${enrollment.courseId}`}
              className="text-brand hover:text-brand-ink hover:underline underline-offset-2"
            >
              {enrollment.courseTitle}
            </a>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">{enrollment.studentName}</h1>
            <EnrollmentStatusChip status={enrollment.status} />
          </div>
        </div>
        {canManage && enrollment.status === 'active' && (
          <RecordLessonDialog
            enrollmentId={enrollment.enrollmentId}
            lessonProgress={enrollment.lessonProgress}
            onSuccess={setEnrollment}
          />
        )}
      </div>

      {/* ── Status controls (manage only, active only) ──────────────────── */}
      {canManage && (
        <StatusControls
          enrollmentId={enrollment.enrollmentId}
          status={enrollment.status}
          onSuccess={setEnrollment}
        />
      )}

      {/* ── Progress summary ─────────────────────────────────────────────── */}
      {/* [VERIFY-T1-B]: content-coverage indicator ONLY — NOT a regulatory completion */}
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-slate-700">
            Operator progress
            <span className="ml-1.5 text-xs font-normal text-slate-400">
              (content coverage — not a regulatory completion)
            </span>
          </h2>
          <span className="nums text-sm text-slate-700 font-medium">
            {formatProgress(pr.completed, pr.total)}
          </span>
        </div>
        <ProgressBar percent={pr.percent} />
        <p
          className="text-xs text-slate-400"
          aria-label={`${pr.completed} of ${pr.total} lessons covered`}
        >
          {pr.completed} of {pr.total} lesson{pr.total !== 1 ? 's' : ''} with a recorded completion.
        </p>
      </div>

      {/* ── Per-lesson checklist ─────────────────────────────────────────── */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">
          Lessons
          <span className="ml-1.5 nums text-slate-400 font-normal">
            ({enrollment.lessonProgress.length})
          </span>
        </h2>

        {enrollment.lessonProgress.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-10 text-center rounded-md border border-dashed border-slate-200"
            role="status"
          >
            <BookOpen className="h-7 w-7 text-slate-300 mb-2" aria-hidden="true" />
            <p className="text-sm text-slate-500">This course has no lessons yet.</p>
            <p className="nums text-xs text-slate-400 mt-0.5">0 / 0 — 0%</p>
          </div>
        ) : (
          <div className="rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm" aria-label="Lesson checklist">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide w-8">
                    <span className="sr-only">Done</span>
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Lesson
                  </th>
                </tr>
              </thead>
              <tbody>
                {enrollment.lessonProgress.map((lp) => (
                  <tr
                    key={lp.lessonId}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-4 py-3">
                      {lp.completed ? (
                        <CheckCircle2
                          className="h-4 w-4 text-green-500"
                          aria-label="Completed"
                        />
                      ) : (
                        <Circle
                          className="h-4 w-4 text-slate-300"
                          aria-label="Not completed"
                        />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`font-medium ${lp.completed ? 'text-slate-900' : 'text-slate-600'}`}
                          >
                            {lp.position + 1}. {lp.title}
                          </span>
                          {/* [VERIFY-T1-G]: stage_label = FREE-TEXT grouping */}
                          {lp.stageLabel && (
                            <span className="inline-flex items-center rounded-sm border border-brand/25 bg-brand/8 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-brand-ink">
                              {lp.stageLabel}
                            </span>
                          )}
                        </div>

                        {/* Show the latest recorded completion details inline */}
                        {lp.completed && (() => {
                          const rec = enrollment.records
                            .filter((r) => r.lessonId === lp.lessonId && r.status === 'recorded')
                            .sort((a, b) =>
                              new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
                            )[0];
                          if (!rec) return null;
                          return (
                            <div className="text-xs text-slate-400 space-x-2">
                              <span>by {rec.instructorName}</span>
                              <span>·</span>
                              <span>{formatDate(rec.completedAt)}</span>
                              {/* [VERIFY-T1-A]: grade_label = FREE-TEXT */}
                              {rec.gradeLabel && (
                                <>
                                  <span>·</span>
                                  <span className="italic">{rec.gradeLabel}</span>
                                </>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Record log ───────────────────────────────────────────────────── */}
      {/* [VERIFY-T1-C]: full log incl. voided records (audit history) */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">
          Record log
          <span className="ml-1.5 nums text-slate-400 font-normal">
            ({enrollment.records.length})
          </span>
        </h2>
        {/* [VERIFY-T1-C]: the persisted log makes the same disclaimer the entry
            form does — the instructor column is attribution, not an endorsement. */}
        <p className="text-xs text-slate-400">
          Instructor-recorded data entry — not a regulatory sign-off or e-signature.
        </p>
        {/* [VERIFY-P2-A]: condensed disclaimer; full text shown in the Sign dialog. */}
        <p className="text-xs text-slate-400">{ESIGN_DISCLAIMER_SHORT}</p>

        {enrollment.records.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No records yet.</p>
        ) : (
          <div className="rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm" aria-label="Lesson record log">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Lesson
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
                    Instructor
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden md:table-cell">
                    Completed
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden lg:table-cell">
                    Grade
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Signature
                  </th>
                  {canManage && (
                    <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wide w-16">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {enrollment.records.map((record) => {
                  const isVoided = record.status === 'voided';
                  // Find lesson title for this record
                  const lesson = enrollment.lessonProgress.find(
                    (lp) => lp.lessonId === record.lessonId,
                  );
                  return (
                    <tr
                      key={record.id}
                      className={`border-b border-slate-100 last:border-0 ${isVoided ? 'opacity-50' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <span className={isVoided ? 'line-through text-slate-400' : 'text-slate-700'}>
                          {lesson ? `${lesson.position + 1}. ${lesson.title}` : 'Unknown lesson'}
                        </span>
                        {isVoided && (
                          <p className="text-xs text-slate-400 mt-0.5">
                            Voided: {record.voidedReason ?? '—'}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <span className={isVoided ? 'line-through text-slate-400' : 'text-slate-600'}>
                          {record.instructorName}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className={`nums text-xs ${isVoided ? 'line-through text-slate-400' : 'text-slate-600'}`}>
                          {formatDateTime(record.completedAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {/* [VERIFY-T1-A]: grade_label = FREE-TEXT only */}
                        <span className={`italic text-xs ${isVoided ? 'line-through text-slate-400' : 'text-slate-500'}`}>
                          {record.gradeLabel ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {isVoided ? (
                          <span className="inline-flex items-center rounded-sm border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-red-700">
                            Voided
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-700">
                            Recorded
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <SignaturePanel lessonRecordId={record.id} canManage={canManage} />
                      </td>
                      {canManage && (
                        <td className="px-4 py-3 text-right">
                          {!isVoided && (
                            <VoidRecordDialog
                              record={record}
                              onSuccess={setEnrollment}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
