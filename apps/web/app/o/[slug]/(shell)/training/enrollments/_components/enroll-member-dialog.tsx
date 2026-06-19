/**
 * enroll-member-dialog.tsx — Dialog for enrolling a member in a course (Slice T1.3).
 *
 * training:manage only (owner/manager/cfi). Server-side gate in enrollMemberAction.
 *
 * Inputs: pick course (required) + pick member (required).
 * Refusals: duplicate → "Already enrolled in this course", not_found inline.
 *
 * Members are fetched on open via listMembersAction (reuses people module).
 *
 * [VERIFY-T1-E]: studentUserId = ANY org member, no role enforcement in T1.
 * [VERIFY-T1-B]: enrollment.status='completed' is operator flag, NOT Part-141.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus, XCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { CourseListRow } from '@aeroops/api';
import { enrollMemberAction, listCoursesAction } from '../../actions';
import { listMembersAction } from '../../../people/actions';
import type { SerializedEnrollmentDetail } from '../../actions';

interface EnrollMemberDialogProps {
  slug: string;
  courses: CourseListRow[];
  initialCourseId?: string;
  onSuccess?: (enrollment: SerializedEnrollmentDetail) => void;
}

interface FieldErrors {
  courseId?: string;
  studentUserId?: string;
}

interface MemberOption {
  userId: string;
  displayName: string;
  email: string;
}

export function EnrollMemberDialog({
  slug,
  courses,
  initialCourseId,
  onSuccess,
}: EnrollMemberDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [courseId, setCourseId] = React.useState(initialCourseId ?? '');
  const [studentUserId, setStudentUserId] = React.useState('');
  const [members, setMembers] = React.useState<MemberOption[]>([]);
  const [loadingMembers, setLoadingMembers] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function resetForm() {
    setCourseId(initialCourseId ?? '');
    setStudentUserId('');
    setFieldErrors({});
    setDialogError(null);
  }

  React.useEffect(() => {
    if (open) {
      resetForm();
      // Load members on open
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
    const errors: FieldErrors = {};
    if (!courseId) errors.courseId = 'Please select a course.';
    if (!studentUserId) errors.studentUserId = 'Please select a member.';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const result = await enrollMemberAction({ courseId, studentUserId });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to enroll members.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'duplicate') {
          setFieldErrors((p) => ({
            ...p,
            studentUserId: 'This member is already enrolled in this course.',
          }));
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Course or member not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess?.(result.enrollment);
      router.push(`/o/${slug}/training/enrollments/${result.enrollment.enrollmentId}`);
      router.refresh();
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm">
        <UserPlus className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Enroll member
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Enroll member in course</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            {/* Course picker (required) */}
            <div className="space-y-1.5">
              <Label htmlFor="em-course">
                Course <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              <select
                id="em-course"
                value={courseId}
                onChange={(e) => {
                  setCourseId(e.target.value);
                  setFieldErrors((p) => ({ ...p, courseId: undefined }));
                }}
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={fieldErrors.courseId ? 'true' : undefined}
                aria-describedby={fieldErrors.courseId ? 'em-course-err' : undefined}
                className={`flex h-10 w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50 ${fieldErrors.courseId ? 'border-red-500' : 'border-slate-200'}`}
              >
                <option value="">Select a course…</option>
                {courses
                  .filter((c) => c.status === 'active')
                  .map((c) => (
                    <option key={c.courseId} value={c.courseId}>
                      {c.title}
                    </option>
                  ))}
              </select>
              {fieldErrors.courseId && (
                <p id="em-course-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.courseId}
                </p>
              )}
            </div>

            {/* Member picker (required) */}
            <div className="space-y-1.5">
              <Label htmlFor="em-member">
                Member <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              {loadingMembers ? (
                <div className="flex items-center gap-2 h-10 px-3 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading members…
                </div>
              ) : (
                <select
                  id="em-member"
                  value={studentUserId}
                  onChange={(e) => {
                    setStudentUserId(e.target.value);
                    setFieldErrors((p) => ({ ...p, studentUserId: undefined }));
                  }}
                  disabled={isSubmitting}
                  aria-required="true"
                  aria-invalid={fieldErrors.studentUserId ? 'true' : undefined}
                  aria-describedby={fieldErrors.studentUserId ? 'em-member-err' : undefined}
                  className={`flex h-10 w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50 ${fieldErrors.studentUserId ? 'border-red-500' : 'border-slate-200'}`}
                >
                  <option value="">Select a member…</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName} — {m.email}
                    </option>
                  ))}
                </select>
              )}
              {fieldErrors.studentUserId && (
                <p id="em-member-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.studentUserId}
                </p>
              )}
              {/* [VERIFY-T1-E]: ANY org member may be enrolled; no role enforcement in T1 */}
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
                    Enrolling…
                  </>
                ) : (
                  'Enroll member'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
