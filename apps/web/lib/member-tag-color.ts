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
  slate: 'border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
  red: 'border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
  amber: 'border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
  green: 'border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-200',
  sky: 'border-sky-200 dark:border-sky-900/50 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300',
  violet: 'border-violet-200 dark:border-violet-900/50 bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300',
  rose: 'border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300',
  teal: 'border-teal-200 dark:border-teal-900/50 bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300',
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
