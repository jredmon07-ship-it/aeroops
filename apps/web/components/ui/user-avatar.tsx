/**
 * components/ui/user-avatar.tsx — the shared person avatar (Slice AVATARS).
 *
 * Renders a member's profile photo when one is set (a size-capped data-URI
 * from app_user.avatar_data — plain <img>, no next/image loader needed for
 * data URIs) and a classic head-and-shoulders silhouette placeholder
 * otherwise — a proper "default profile photo", not a bare colored disc.
 * Server-safe: no client hooks; usable in RSCs and client components alike.
 */
import * as React from 'react';

const SIZE_CLASSES = {
  xs: 'h-6 w-6',
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-16 w-16',
  xl: 'h-24 w-24',
} as const;

export type UserAvatarSize = keyof typeof SIZE_CLASSES;

interface UserAvatarProps {
  /** Display name — drives the initials fallback and the img alt text. */
  name: string | null | undefined;
  /** data:image/... URI from the avatar API, or null for initials. */
  src?: string | null;
  size?: UserAvatarSize;
  className?: string;
}

export function UserAvatar({ name, src, size = 'sm', className }: UserAvatarProps) {
  const sizeClass = SIZE_CLASSES[size];
  const label = (name ?? '').trim() || 'Member';

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data-URI avatars need no loader
      <img
        src={src}
        alt={`${label} profile photo`}
        className={[
          'rounded-full object-cover shrink-0 border border-slate-200 dark:border-slate-700',
          sizeClass,
          className ?? '',
        ].join(' ')}
      />
    );
  }

  // No photo set → the classic head-and-shoulders placeholder. The figure is
  // slightly oversized and bottom-anchored so the shoulders crop at the frame,
  // reading as a "default profile photo" at every size.
  return (
    <span
      aria-hidden="true"
      title={label}
      className={[
        'relative block overflow-hidden rounded-full shrink-0 select-none',
        'bg-slate-200 text-slate-500 dark:bg-slate-600 dark:text-slate-300',
        'border border-slate-300 dark:border-slate-500',
        sizeClass,
        className ?? '',
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        className="absolute inset-x-0 bottom-[-6%] h-full w-full"
        aria-hidden="true"
      >
        <circle cx="12" cy="8.4" r="4.5" />
        <path d="M12 14.9c-5 0-8.7 2.7-8.7 6.5V24h17.4v-2.6c0-3.8-3.7-6.5-8.7-6.5Z" />
      </svg>
    </span>
  );
}
