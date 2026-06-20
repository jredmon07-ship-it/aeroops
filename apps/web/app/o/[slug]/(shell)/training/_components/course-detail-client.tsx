/**
 * course-detail-client.tsx — Interactive course detail view (Slice T1.3).
 *
 * Renders the course header, ordered lesson list, Add lesson dialog,
 * and Remove lesson confirmation (with has_records inline error).
 *
 * [VERIFY-T1-G]: stage_label is FREE-TEXT operator grouping, NOT a Part-141 stage.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BookOpen, PlusCircle, Trash2, XCircle, Loader2, AlertTriangle } from 'lucide-react';
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
import { addCourseLessonAction, removeCourseLessonAction } from '../actions';
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
  const [fieldErrors, setFieldErrors] = React.useState<AddLessonFieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function resetForm() {
    setTitle('');
    setDescription('');
    setStageLabel('');
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

// ─── Main client component ─────────────────────────────────────────────────────

interface CourseDetailClientProps {
  course: SerializedCourseDetail;
  slug: string;
  canManage: boolean;
}

export function CourseDetailClient({ course: initialCourse, slug, canManage }: CourseDetailClientProps) {
  const [course, setCourse] = React.useState(initialCourse);

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

      {/* ── Lessons list ────────────────────────────────────────────────── */}
      <div className="space-y-2">
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
                    <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wide w-16">
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
                        </div>
                        {lesson.description && (
                          <p className="text-xs text-slate-400 line-clamp-2">{lesson.description}</p>
                        )}
                      </div>
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <RemoveLessonConfirm
                          lessonId={lesson.lessonId}
                          lessonTitle={lesson.title}
                          onSuccess={setCourse}
                        />
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
