/**
 * tag-editor.tsx — Add/remove member tags.
 *
 * people:manage only. Tags are free-text operator labels.
 * UI trims; server enforces non-empty + uniqueness (case-sensitive).
 * Duplicate inline error; removal by tagId.
 *
 * [VERIFY-6-A]: tags are free-text only; no FAA/eligibility meaning.
 */
'use client';

import * as React from 'react';
import { Plus, X, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { addMemberTagAction, removeMemberTagAction } from '../actions';
import type { SerializedMemberDetail, SerializedMemberTagView } from '../actions';
import type { MemberTagColor } from '@aeroops/api';
import {
  MEMBER_TAG_COLOR_KEYS,
  MEMBER_TAG_COLOR_LABELS,
  tagChipClasses,
  tagDotClasses,
} from '@/lib/member-tag-color';

interface TagEditorProps {
  member: SerializedMemberDetail;
  canManage: boolean;
  onUpdate?: (updated: SerializedMemberDetail) => void;
}

export function TagEditor({ member, canManage, onUpdate }: TagEditorProps) {
  const [tags, setTags] = React.useState<SerializedMemberTagView[]>(member.tags);
  const [newTag, setNewTag] = React.useState('');
  const [newColor, setNewColor] = React.useState<MemberTagColor>('slate');
  const [addError, setAddError] = React.useState<string | null>(null);
  const [isAdding, setIsAdding] = React.useState(false);
  const [removingIds, setRemovingIds] = React.useState<Set<string>>(new Set());
  const [removeErrors, setRemoveErrors] = React.useState<Record<string, string>>({});

  // Sync tags when member prop changes (e.g. after edit)
  React.useEffect(() => {
    setTags(member.tags);
  }, [member.tags]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newTag.trim();
    if (!trimmed) {
      setAddError('Tag cannot be empty.');
      return;
    }
    setAddError(null);
    setIsAdding(true);
    try {
      const result = await addMemberTagAction({
        userId: member.userId,
        tag: trimmed,
        color: newColor,
      });
      if ('error' in result) {
        if (result.error === 'validation') {
          setAddError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setAddError('You do not have permission to add tags.');
          return;
        }
        setAddError('Something went wrong. Please try again.');
        return;
      }
      if (!result.ok) {
        if (result.reason === 'duplicate') {
          setAddError(`Tag "${trimmed}" already exists on this member.`);
          return;
        }
        if (result.reason === 'not_found') {
          setAddError('Member not found.');
          return;
        }
        setAddError('Something went wrong. Please try again.');
        return;
      }
      setTags(result.member.tags);
      setNewTag('');
      onUpdate?.(result.member);
    } catch {
      setAddError('Something went wrong. Please try again.');
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(tagId: string, tagLabel: string) {
    setRemovingIds((prev) => new Set(prev).add(tagId));
    setRemoveErrors((prev) => {
      const next = { ...prev };
      delete next[tagId];
      return next;
    });
    try {
      const result = await removeMemberTagAction({ userId: member.userId, tagId });
      if ('error' in result) {
        setRemoveErrors((prev) => ({
          ...prev,
          [tagId]: 'Could not remove tag. Try again.',
        }));
        return;
      }
      if (!result.ok) {
        setRemoveErrors((prev) => ({
          ...prev,
          [tagId]: result.reason === 'not_found' ? 'Tag not found.' : 'Could not remove tag.',
        }));
        return;
      }
      setTags(result.member.tags);
      onUpdate?.(result.member);
    } catch {
      setRemoveErrors((prev) => ({
        ...prev,
        [tagId]: 'Could not remove tag. Try again.',
      }));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(tagId);
        return next;
      });
    }
  }

  return (
    <div className="space-y-3" aria-label="Member tags">
      {/* [VERIFY-6-A] disclaimer */}
      <p className="text-xs text-slate-400 dark:text-slate-500">
        Free-text operator labels only. Tags carry no regulatory or eligibility meaning.
      </p>

      {/* Existing tags */}
      {tags.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 italic">No tags yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="Current tags">
          {tags.map((t) => (
            <span
              key={t.id}
              role="listitem"
              className={[
                'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium',
                tagChipClasses(t.color),
              ].join(' ')}
            >
              {t.tag}
              {canManage && (
                <button
                  type="button"
                  onClick={() => handleRemove(t.id, t.tag)}
                  disabled={removingIds.has(t.id)}
                  aria-label={`Remove tag ${t.tag}`}
                  className="ml-0.5 rounded-sm text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:opacity-50"
                >
                  {removingIds.has(t.id) ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <X className="h-3 w-3" aria-hidden="true" />
                  )}
                </button>
              )}
              {removeErrors[t.id] && (
                <span className="text-xs text-red-600 dark:text-red-400 ml-1" role="alert">
                  {removeErrors[t.id]}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Add tag form (manage only) */}
      {canManage && (
        <form onSubmit={handleAdd} className="space-y-2" noValidate>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Input
                value={newTag}
                onChange={(e) => {
                  setNewTag(e.target.value);
                  setAddError(null);
                }}
                placeholder="Add tag…"
                disabled={isAdding}
                maxLength={100}
                aria-label="New tag"
                aria-invalid={addError ? 'true' : undefined}
                aria-describedby={addError ? 'tag-add-err' : undefined}
                className={addError ? 'border-red-500' : ''}
              />
              {addError && (
                <p id="tag-add-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {addError}
                </p>
              )}
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={isAdding} isLoading={isAdding}>
              <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
              Add
            </Button>
          </div>
          {/* Color picker dots */}
          <fieldset className="flex items-center gap-1.5">
            <legend className="sr-only">Tag color</legend>
            <span className="text-xs text-slate-400 dark:text-slate-500 mr-0.5">Color:</span>
            {MEMBER_TAG_COLOR_KEYS.map((color) => {
              const selected = newColor === color;
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => setNewColor(color)}
                  disabled={isAdding}
                  aria-pressed={selected}
                  aria-label={MEMBER_TAG_COLOR_LABELS[color]}
                  title={MEMBER_TAG_COLOR_LABELS[color]}
                  className={[
                    'h-4 w-4 rounded-full ring-offset-1 transition',
                    tagDotClasses(color),
                    selected
                      ? 'ring-2 ring-brand ring-offset-white'
                      : 'ring-1 ring-slate-200 dark:ring-slate-700 hover:ring-slate-400 dark:hover:ring-slate-500',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50',
                  ].join(' ')}
                />
              );
            })}
          </fieldset>
        </form>
      )}
    </div>
  );
}
