/**
 * member-detail-client.tsx — Client wrapper for member detail interactive elements.
 *
 * Owns the mutable member state (after Edit / Status toggle / Tag changes)
 * and renders:
 *   - Identity header (status chip + role badge + "no login" hint)
 *   - Edit dialog (people:manage)
 *   - Status toggle (people:manage)
 *   - Tags card (with TagEditor)
 *
 * Static read-only cards (Contact, Upcoming Reservations, Dispatch) are
 * rendered server-side in the page and receive the original immutable data.
 * This client component only needs to refresh the page on mutation success —
 * using router.refresh() to re-run the RSC data fetch.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Tag } from 'lucide-react';
import { ROLE_LABELS } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import type { SerializedMemberDetail } from '../actions';
import { updateMemberAvatarAction } from '../actions';
import { EditMemberDialog } from './edit-member-dialog';
import { StatusToggle } from './status-toggle';
import { TagEditor } from './tag-editor';
import { UserAvatar } from '@/components/ui/user-avatar';
import { AvatarUpload } from '@/components/ui/avatar-upload';
import { actionErrorMessage } from '@/lib/action-feedback';

// ─── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">
      Inactive
    </span>
  );
}

// ─── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  const label = ROLE_LABELS[role as MembershipRole] ?? role;
  return (
    <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-brand-ink">
      {label}
    </span>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface MemberDetailClientProps {
  member: SerializedMemberDetail;
  slug: string;
  canManage: boolean;
  /** null when no photo is set (or migration 0048 is unapplied). */
  avatarDataUrl: string | null;
  /** false while migration 0048 is unapplied — hides the upload control. */
  avatarAvailable: boolean;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function MemberDetailClient({
  member: initialMember,
  slug,
  canManage,
  avatarDataUrl: initialAvatarDataUrl,
  avatarAvailable,
}: MemberDetailClientProps) {
  const router = useRouter();
  const [member, setMember] = React.useState<SerializedMemberDetail>(initialMember);
  const [avatarDataUrl, setAvatarDataUrl] = React.useState<string | null>(initialAvatarDataUrl);

  // Sync if the server re-renders with fresh data (e.g. after router.refresh)
  React.useEffect(() => {
    setMember(initialMember);
  }, [initialMember]);

  React.useEffect(() => {
    setAvatarDataUrl(initialAvatarDataUrl);
  }, [initialAvatarDataUrl]);

  function handleMemberUpdate(updated: SerializedMemberDetail) {
    setMember(updated);
    // Refresh RSC to update static cards (Contact has phone; Dispatch/Reservations are static)
    router.refresh();
  }

  function handleTagUpdate(updated: SerializedMemberDetail) {
    setMember(updated);
    // Tags are managed entirely in client state; no full RSC refresh needed.
  }

  async function handleAvatarSave(dataUrl: string | null) {
    const result = await updateMemberAvatarAction(member.userId, dataUrl, slug);
    if ('error' in result) {
      return { ok: false, message: actionErrorMessage(result) };
    }
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === 'member_not_found'
            ? 'Member not found.'
            : "Photos aren't available yet.",
      };
    }
    setAvatarDataUrl(dataUrl);
    return { ok: true };
  }

  return (
    <>
      {/* ── Identity header ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <UserAvatar name={member.displayName} src={avatarDataUrl} size="xl" />
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">{member.displayName}</h1>
              <StatusChip status={member.status} />
              <RoleBadge role={member.role} />
            </div>
            {/* [AUTH-DECISION]: no-login hint — only for members without a credential. */}
            {!member.hasLogin && (
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Roster entry — no login yet. Login access requires a future invite slice.
              </p>
            )}
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Member since{' '}
              {member.joinedAt
                ? new Intl.DateTimeFormat('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  }).format(new Date(member.joinedAt))
                : '—'}
            </p>

            {canManage &&
              (avatarAvailable ? (
                <AvatarUpload
                  name={member.displayName}
                  currentSrc={avatarDataUrl}
                  onSave={handleAvatarSave}
                  className="pt-1"
                />
              ) : (
                <p className="pt-1 text-xs text-slate-400 dark:text-slate-500">
                  Profile photos become available in an upcoming update.
                </p>
              ))}
          </div>
        </div>

        {canManage && (
          <div className="flex items-center gap-2">
            <EditMemberDialog member={member} onSuccess={handleMemberUpdate} />
            <StatusToggle member={member} onSuccess={handleMemberUpdate} />
          </div>
        )}
      </div>

      {/* ── Tags card ──────────────────────────────────────────────────────── */}
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Tag className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Tags</h2>
        </div>
        <TagEditor member={member} canManage={canManage} onUpdate={handleTagUpdate} />
      </div>
    </>
  );
}
