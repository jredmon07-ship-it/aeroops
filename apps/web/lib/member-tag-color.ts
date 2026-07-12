/**
 * member-tag-color.ts — the single source of truth mapping a member-tag palette
 * KEY (migration 0041) to LITERAL Tailwind classes.
 *
 * Tailwind's JIT compiler only emits classes it can see as complete string
 * literals at build time, so every class here is written out in full — there is
 * NO dynamic class construction (e.g. `bg-${color}-100`). A null/unknown color
 * falls back to the neutral 'slate' chip.
 *
 * [VERIFY-6-A]: a tag's color is a DISPLAY hint only — it carries no regulatory
 * or eligibility meaning.
 */

import type { MemberTagColor } from '@aeroops/api';

/**
 * The eight selectable colors, in palette order (for the picker).
 *
 * LITERAL COPY of @aeroops/api's MEMBER_TAG_COLORS — a VALUE import from the
 * server barrel would pull packages/api (node:crypto, argon2, …) into the
 * client bundle and break `next build`. The type-only import above is erased
 * at compile time, so the `satisfies` check below keeps the two lists in sync:
 * if the api palette changes, this assignment stops typechecking.
 */
export const MEMBER_TAG_COLOR_KEYS = [
  'slate',
  'red',
  'amber',
  'green',
  'sky',
  'violet',
  'rose',
  'teal',
] as const satisfies readonly MemberTagColor[];

/** Human labels for the picker's accessible names. */
export const MEMBER_TAG_COLOR_LABELS: Record<MemberTagColor, string> = {
  slate: 'Slate',
  red: 'Red',
  amber: 'Amber',
  green: 'Green',
  sky: 'Sky',
  violet: 'Violet',
  rose: 'Rose',
  teal: 'Teal',
};

/** Chip classes (border + background + text) for a colored tag chip. */
const CHIP_CLASSES: Record<MemberTagColor, string> = {
  slate: 'border-slate-200 bg-slate-100 text-slate-700',
  red: 'border-red-200 bg-red-50 text-red-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  green: 'border-green-200 bg-green-50 text-green-800',
  sky: 'border-sky-200 bg-sky-50 text-sky-700',
  violet: 'border-violet-200 bg-violet-50 text-violet-700',
  rose: 'border-rose-200 bg-rose-50 text-rose-700',
  teal: 'border-teal-200 bg-teal-50 text-teal-700',
};

/** Solid swatch classes for the color-picker dots. */
const DOT_CLASSES: Record<MemberTagColor, string> = {
  slate: 'bg-slate-400',
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  rose: 'bg-rose-500',
  teal: 'bg-teal-500',
};

/** Resolve chip classes for a (possibly null/unknown) color key → slate default. */
export function tagChipClasses(color: string | null | undefined): string {
  if (color && color in CHIP_CLASSES) return CHIP_CLASSES[color as MemberTagColor];
  return CHIP_CLASSES.slate;
}

/** Resolve dot classes for a color key. */
export function tagDotClasses(color: MemberTagColor): string {
  return DOT_CLASSES[color];
}
