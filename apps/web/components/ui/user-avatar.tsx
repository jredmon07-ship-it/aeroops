/**
 * components/ui/user-avatar.tsx — the shared person avatar (Slice AVATARS).
 *
 * Renders a member's profile photo when one is set (a size-capped data-URI
 * from app_user.avatar_data — plain <img>, no next/image loader needed for
 * data URIs) and deterministic initials on brand-tinted background otherwise.
 * Server-safe: no client hooks; usable in RSCs and client components alike.
 */
import * as React from 'react';

const SIZE_CLASSES = {
  xs: 'h-6 w-6 text-[0.625rem]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-xl',
  xl: 'h-24 w-24 text-3xl',
} as const;

export type UserAvatarSize = keyof typeof SIZE_CLASSES;

/** "Avery Owner" → "AO"; "solo" → "S"; falls back to "?" for empty input. */
export function initialsFor(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

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

  return (
    <span
      aria-hidden="true"
      title={label}
      className={[
        'grid place-items-center rounded-full shrink-0 select-none font-semibold',
        'bg-brand-ink/10 text-brand-ink dark:bg-slate-700 dark:text-slate-200',
        sizeClass,
        className ?? '',
      ].join(' ')}
    >
      {initialsFor(name)}
    </span>
  );
}
