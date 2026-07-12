/**
 * course-detail-client.tsx — Interactive course detail view (Slice T1.3).
 *
 * Renders the course header, ordered lesson list, Add lesson dialog,
 * and Remove lesson confirmation (with has_records inline error).
 *
 * Slice P2-SC1 additions: per-lesson "Stage check" toggle, course-level
 * "Enforce stage checks" toggle. COMPLIANCE HARD LINE: both flags configure
 * the OPERATOR's course structure ONLY — NOT a Part-61/141 stage check of
 * record or any FAA determination.
 *
 * [VERIFY-T1-G]: stage_label is FREE-TEXT operator grouping, NOT a Part-141 stage.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BookOpen, PlusCircle, Trash2, XCircle, Loader2, AlertTriangle, Flag } from 'lucide-react';
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
import type { SerializedCourseDetail } from '../actions';
import {
  addCourseLessonAction,
  removeCourseLessonAction,
  setLessonStageCheckAction,
  setCourseStageCheckEnforcementAction,
} from '../actions';
import { courseStatusLabel } from './training-utils';

// ─── Course status chip ────────────────────────────────────────────────────────

function CourseStatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800">
        {courseStatusLabel(status)}
      </span>
    );
  }
  if (status === 'archived') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
        {courseStatusLabel(status)}
      </span>
    );
  }
  return <span className="text-xs text-slate-400">{status}</span>;
}

// ─── Stage label chip ──────────────────────────────────────────────────────────
// [VERIFY-T1-G]: FREE-TEXT operator grouping, NOT a Part-141 stage.

function StageLabelChip({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center rounded-sm border border-brand/25 bg-brand/8 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-brand-ink"
      title="Operator-defined grouping label (not a Part-141 stage)"
    >
      {label}
    </span>
  );
}

// ─── Stage check chip (Slice P2-SC1) ───────────────────────────────────────────
// Operator flag — NOT a Part-61/141 stage check of record.

function StageCheckChip() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-amber-800"
      title="Operator-designated stage check — not a Part-61/141 stage check of record"
    >
      <Flag className="h-3 w-3" aria-hidden="true" />
      Stage check
    </span>
  );
}

// ─── Add Lesson Dialog ─────────────────────────────────────────────────────────

interface AddLessonDialogProps {
  courseId: string;
  onSuccess: (course: SerializedCourseDetail) => void;
}

interface AddLessonFieldErrors {
  title?: string;
}

function AddLessonDialog({ courseId, onSuccess }: AddLessonDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [stageLabel, setStageLabel] = React.useState('');
  const [isStageCheck, setIsStageCheck] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<AddLessonFieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function resetForm() {
    setTitle('');
    setDescription('');
    setStageLabel('');
    setIsStageCheck(false);
    setFieldErrors({});
    setDialogError(null);
  }

  React.useEffect(() => {
    if (open) resetForm();
  }, [open]);

  function validate(): boolean {
    const errors: AddLessonFieldErrors = {};
    if (!title.trim()) {
      errors.title = 'Lesson title is required.';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const result = await addCourseLessonAction({
        courseId,
        title: title.trim(),
        description: description.trim() || undefined,
        stageLabel: stageLabel.trim() || undefined,
        isStageCheck: isStageCheck || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          const msg = result.message.toLowerCase();
          if (msg.includes('title')) {
            setFieldErrors((p) => ({ ...p, title: result.message }));
          } else {
            setDialogError(result.message);
          }
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to add lessons.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_found') {
          setDialogError('Course not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess(result.course);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm">
        <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Add lesson
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add lesson</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            {/* Title (required) */}
            <div className="space-y-1.5">
              <Label htmlFor="al-title">
                Lesson title <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              <Input
                id="al-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setFieldErrors((p) => ({ ...p, title: undefined }));
                }}
                placeholder="e.g. Weight and Balance"
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={fieldErrors.title ? 'true' : undefined}
                aria-describedby={fieldErrors.title ? 'al-title-err' : undefined}
                className={fieldErrors.title ? 'border-red-500' : ''}
              />
              {fieldErrors.title && (
                <p id="al-title-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.title}
                </p>
              )}
            </div>

            {/* Stage label (optional) — FREE-TEXT operator grouping [VERIFY-T1-G] */}
            <div className="space-y-1.5">
              <Label htmlFor="al-stage">
                Stage label (optional)
              </Label>
              <Input
                id="al-stage"
                value={stageLabel}
                onChange={(e) => setStageLabel(e.target.value)}
                placeholder="e.g. Ground School, Solo Prep"
                disabled={isSubmitting}
              />
              <p className="text-xs text-slate-400">
                Free-text operator grouping label — not a regulatory stage.
              </p>
            </div>

            {/* Stage check (optional) — operator flag, Slice P2-SC1 */}
            <div className="flex items-start gap-2.5">
              <input
                id="al-stage-check"
                type="checkbox"
                checked={isStageCheck}
                onChange={(e) => setIsStageCheck(e.target.checked)}
                disabled={isSubmitting}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              />
              <div className="space-y-0.5">
                <Label htmlFor="al-stage-check" className="cursor-pointer">
                  Stage check
                </Label>
                <p className="text-xs text-slate-400">
                  Marks this lesson a milestone evaluation in your course structure — not a
                  Part-61/141 stage check of record.
                </p>
              </div>
            </div>

            {/* Description (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="al-description">Description (optional)</Label>
              <textarea
                id="al-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this lesson…"
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
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />
                    Adding…
                  </>
                ) : (
                  'Add lesson'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Remove Lesson Confirm ─────────────────────────────────────────────────────

interface RemoveLessonConfirmProps {
  lessonId: string;
  lessonTitle: string;
  onSuccess: (course: SerializedCourseDetail) => void;
}

function RemoveLessonConfirm({
  lessonId,
  lessonTitle,
  onSuccess,
}: RemoveLessonConfirmProps) {
  const [open, setOpen] = React.useState(false);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) setDialogError(null);
  }, [open]);

  async function handleConfirm() {
    setDialogError(null);
    setIsSubmitting(true);
    try {
      const result = await removeCourseLessonAction({ lessonId });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to remove lessons.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'has_records') {
          setDialogError(
            'This lesson has recorded completions and cannot be removed.',
          );
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Lesson not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess(result.course);
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
        className="text-slate-400 hover:text-danger hover:bg-danger/5"
        aria-label={`Remove lesson: ${lessonTitle}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove lesson</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <p className="text-sm text-slate-700">
              Are you sure you want to remove{' '}
              <strong className="font-semibold">{lessonTitle}</strong>?
            </p>
            <p className="text-sm text-slate-500">
              This action cannot be undone. Lessons with recorded completions cannot be removed.
            </p>

            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}
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
                  Removing…
                </>
              ) : (
                'Remove lesson'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Lesson stage-check toggle (Slice P2-SC1) ──────────────────────────────────
// Operator flag ONLY — NOT a Part-61/141 stage check of record.

interface LessonStageCheckToggleProps {
  lessonId: string;
  lessonTitle: string;
  isStageCheck: boolean;
  onSuccess: (course: SerializedCourseDetail) => void;
  onError: (message: string) => void;
}

function LessonStageCheckToggle({
  lessonId,
  lessonTitle,
  isStageCheck,
  onSuccess,
  onError,
}: LessonStageCheckToggleProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleToggle() {
    setIsSubmitting(true);
    try {
      const result = await setLessonStageCheckAction({
        lessonId,
        isStageCheck: !isStageCheck,
      });

      if ('error' in result) {
        onError(
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to change stage-check settings.'
            : 'Something went wrong. Please try again.',
        );
        return;
      }
      if (!result.ok) {
        onError(result.reason === 'not_found' ? 'Lesson not found.' : 'Something went wrong. Please try again.');
        return;
      }
      onSuccess(result.course);
    } catch {
      onError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggle}
      disabled={isSubmitting}
      className="text-slate-400 hover:text-amber-700 hover:bg-amber-50 text-xs"
      aria-label={
        isStageCheck
          ? `Unmark stage check: ${lessonTitle}`
          : `Mark as stage check: ${lessonTitle}`
      }
      title="Operator flag — not a Part-61/141 stage check of record"
    >
      {isSubmitting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : isStageCheck ? (
        'Unmark stage check'
      ) : (
        'Mark stage check'
      )}
    </Button>
  );
}

// ─── Enforce-stage-checks toggle (Slice P2-SC1) ────────────────────────────────
// Operator opt-in — enforces YOUR course structure, not a Part-61/141 rule.

interface EnforceStageChecksToggleProps {
  courseId: string;
  enforceStageChecks: boolean;
  onSuccess: (course: SerializedCourseDetail) => void;
}

function EnforceStageChecksToggle({
  courseId,
  enforceStageChecks,
  onSuccess,
}: EnforceStageChecksToggleProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleToggle(next: boolean) {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await setCourseStageCheckEnforcementAction({
        courseId,
        enforceStageChecks: next,
      });

      if ('error' in result) {
        setError(
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to change course settings.'
            : 'Something went wrong. Please try again.',
        );
        return;
      }
      if (!result.ok) {
        setError(result.reason === 'not_found' ? 'Course not found.' : 'Something went wrong. Please try again.');
        return;
      }
      onSuccess(result.course);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-slate-700">Enforce stage checks</h2>
          <p className="text-xs text-slate-500">
            Blocks recording lessons past an unpassed stage check. This enforces YOUR course
            structure — it is not a Part-61/141 determination.
          </p>
        </div>
        <label
          className="relative inline-flex items-center cursor-pointer shrink-0"
          aria-label={`Stage-check enforcement ${enforceStageChecks ? 'enabled' : 'disabled'}`}
        >
          <input
            type="checkbox"
            className="sr-only peer"
            checked={enforceStageChecks}
            onChange={(e) => handleToggle(e.target.checked)}
            disabled={isSubmitting}
          />
          <div className="w-9 h-5 rounded-full bg-slate-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-brand peer-checked:bg-brand after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
        </label>
      </div>
      {error && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ─── Main client component ─────────────────────────────────────────────────────

interface CourseDetailClientProps {
  course: SerializedCourseDetail;
  slug: string;
  canManage: boolean;
}

export function CourseDetailClient({ course: initialCourse, slug, canManage }: CourseDetailClientProps) {
  const [course, setCourse] = React.useState(initialCourse);
  const [lessonToggleError, setLessonToggleError] = React.useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">{course.title}</h1>
            <CourseStatusChip status={course.status} />
          </div>
          {course.description && (
            <p className="text-sm text-slate-500">{course.description}</p>
          )}
        </div>
        {canManage && (
          <AddLessonDialog courseId={course.courseId} onSuccess={setCourse} />
        )}
      </div>

      {/* ── Course settings: stage-check enforcement (Slice P2-SC1) ─────── */}
      {/* Operator opt-in — enforces YOUR course structure, not Part-61/141. */}
      {canManage && (
        <EnforceStageChecksToggle
          courseId={course.courseId}
          enforceStageChecks={course.enforceStageChecks}
          onSuccess={setCourse}
        />
      )}

      {/* ── Lessons list ────────────────────────────────────────────────── */}
      <div className="space-y-2">
        {lessonToggleError && (
          <Alert variant="destructive" role="alert" aria-live="assertive">
            <XCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{lessonToggleError}</AlertDescription>
          </Alert>
        )}
        <h2 className="text-sm font-semibold text-slate-700">
          Lessons
          <span className="ml-1.5 nums text-slate-400 font-normal">
            ({course.lessons.length})
          </span>
        </h2>

        {course.lessons.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-12 text-center space-y-2 rounded-md border border-dashed border-slate-200"
            role="status"
          >
            <BookOpen className="h-8 w-8 text-slate-300" aria-hidden="true" />
            <p className="text-sm text-slate-500">No lessons yet.</p>
            {canManage && (
              <p className="text-xs text-slate-400">
                Use{' '}
                <button
                  className="text-brand underline underline-offset-2 hover:text-brand-ink"
                  onClick={() => {
                    // Trigger the Add Lesson dialog via the header button
                    // (users can scroll up or we just give a hint)
                  }}
                >
                  Add lesson
                </button>{' '}
                above to add the first lesson.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm" aria-label="Course lessons">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide w-12">
                    #
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Lesson
                  </th>
                  {canManage && (
                    <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wide w-52">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {course.lessons.map((lesson) => (
                  <tr
                    key={lesson.lessonId}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <span className="nums text-slate-400 text-xs">{lesson.position + 1}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-900">{lesson.title}</span>
                          {/* [VERIFY-T1-G]: stage_label = FREE-TEXT grouping only */}
                          {lesson.stageLabel && <StageLabelChip label={lesson.stageLabel} />}
                          {/* Slice P2-SC1: operator flag — NOT a Part-61/141 stage check */}
                          {lesson.isStageCheck && <StageCheckChip />}
                        </div>
                        {lesson.description && (
                          <p className="text-xs text-slate-400 line-clamp-2">{lesson.description}</p>
                        )}
                      </div>
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          {/* Slice P2-SC1: operator stage-check toggle */}
                          <LessonStageCheckToggle
                            lessonId={lesson.lessonId}
                            lessonTitle={lesson.title}
                            isStageCheck={lesson.isStageCheck}
                            onSuccess={(c) => {
                              setLessonToggleError(null);
                              setCourse(c);
                            }}
                            onError={setLessonToggleError}
                          />
                          <RemoveLessonConfirm
                            lessonId={lesson.lessonId}
                            lessonTitle={lesson.title}
                            onSuccess={setCourse}
                          />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Enrollments link ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 pt-2">
        <Link
          href={`/o/${slug}/training/enrollments?courseId=${course.courseId}`}
          className="text-sm text-brand hover:text-brand-ink hover:underline underline-offset-2"
        >
          View enrollments for this course →
        </Link>
      </div>
    </div>
  );
}
