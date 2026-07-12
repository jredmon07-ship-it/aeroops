/**
 * build-course-dialog.tsx — Dialog for building a new training course (Slice T1.3).
 *
 * training:manage only (owner/manager/cfi). Server-side gate in createCourseAction.
 *
 * Input: title (required) + description (optional).
 * On success: navigates to the new course detail page.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { PlusCircle, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { createCourseAction } from '../actions';

interface BuildCourseDialogProps {
  slug: string;
}

interface FieldErrors {
  title?: string;
}

export function BuildCourseDialog({ slug }: BuildCourseDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function resetForm() {
    setTitle('');
    setDescription('');
    setFieldErrors({});
    setDialogError(null);
  }

  React.useEffect(() => {
    if (open) resetForm();
  }, [open]);

  function validate(): boolean {
    const errors: FieldErrors = {};
    if (!title.trim()) {
      errors.title = 'Course title is required.';
    } else if (title.trim().length > 500) {
      errors.title = 'Title must be 500 characters or fewer.';
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
      const result = await createCourseAction({
        title: title.trim(),
        description: description.trim() || undefined,
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
          setDialogError('You do not have permission to create courses.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      router.push(`/o/${slug}/training/${result.course.courseId}`);
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
        <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Build course
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Build a new course</DialogTitle>
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
              <Label htmlFor="bc-title">
                Title <span aria-hidden="true" className="text-red-500">*</span>
              </Label>
              <Input
                id="bc-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setFieldErrors((p) => ({ ...p, title: undefined }));
                }}
                placeholder="e.g. Private Pilot Ground School"
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={fieldErrors.title ? 'true' : undefined}
                aria-describedby={fieldErrors.title ? 'bc-title-err' : undefined}
                className={fieldErrors.title ? 'border-red-500' : ''}
              />
              {fieldErrors.title && (
                <p id="bc-title-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.title}
                </p>
              )}
            </div>

            {/* Description (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="bc-description">Description (optional)</Label>
              <textarea
                id="bc-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this course…"
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
              <Button type="submit" disabled={isSubmitting} isLoading={isSubmitting}>
                Create course
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
