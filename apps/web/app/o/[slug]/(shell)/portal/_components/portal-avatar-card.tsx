/**
 * portal-avatar-card.tsx — "Your photo" self-service card for the portal
 * (Slice AVATARS).
 *
 * Any portal:access role (student, renter, owner, manager) may set or clear
 * their OWN photo — self-scoped end to end (setMyAvatarAction takes no
 * userId; the subject is always session.userId inside setMyAvatar).
 *
 * GRACEFUL ABSENCE: while migration 0048 is unapplied (available:false), the
 * upload control is hidden entirely — just the initials avatar renders, no
 * upsell copy.
 */
'use client';

import * as React from 'react';
import { UserAvatar } from '@/components/ui/user-avatar';
import { AvatarUpload } from '@/components/ui/avatar-upload';
import { SectionHeader } from '@/components/ui/section-header';
import { actionErrorMessage } from '@/lib/action-feedback';
import { setMyAvatarAction } from '../actions';

export interface PortalAvatarCardProps {
  slug: string;
  displayName: string;
  initialAvatarDataUrl: string | null;
  available: boolean;
}

export function PortalAvatarCard({
  slug,
  displayName,
  initialAvatarDataUrl,
  available,
}: PortalAvatarCardProps) {
  const [avatarDataUrl, setAvatarDataUrl] = React.useState<string | null>(initialAvatarDataUrl);

  async function handleSave(dataUrl: string | null) {
    const result = await setMyAvatarAction(dataUrl, slug);
    if ('error' in result) {
      return { ok: false, message: actionErrorMessage(result) };
    }
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === 'member_not_found'
            ? 'Your account could not be found.'
            : "Photos aren't available yet.",
      };
    }
    setAvatarDataUrl(dataUrl);
    return { ok: true };
  }

  return (
    <section aria-label="Your photo">
      <SectionHeader eyebrow="Your photo" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs px-5 py-4 flex items-center gap-4">
        <UserAvatar name={displayName} src={avatarDataUrl} size="lg" />
        {available && <AvatarUpload name={displayName} currentSrc={avatarDataUrl} onSave={handleSave} />}
      </div>
    </section>
  );
}
