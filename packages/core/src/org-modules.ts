/**
 * org-modules.ts — the pure per-org module registry (feature toggles +
 * operating-mode presets, migration 0047).
 *
 * A MODULE is a whole area of the app an operator can turn off (leaner nav for
 * a small flying club). Core surfaces — scheduling, dispatch board, fleet,
 * people, dashboard, org settings, help — are NOT modules and can never be
 * disabled. Toggling a module off hides it from nav + global search and blocks
 * its routes server-side; it NEVER deletes or mutates the module's data
 * ("hide, don't destroy": flip it back on and everything is exactly as it was).
 *
 * OPERATING MODE is a preset label ('school' | 'club'), chosen at setup and
 * changeable later. Applying a mode writes that preset into the individual
 * module flags; each flag stays independently editable afterwards. Enforcement
 * reads ONLY the flags — the mode itself gates nothing.
 *
 * PURE: no DB, no I/O, no framework imports. Unit-testable everywhere
 * (web nav filter, api enforcement, tests).
 */

// ─── Module keys ──────────────────────────────────────────────────────────────

export const ORG_MODULES = [
  'training',
  'maintenance',
  'billing',
  'booking',
  'portal',
  'reports',
  'auto_schedule',
  'messages',
] as const;

export type OrgModuleKey = (typeof ORG_MODULES)[number];

/** Per-org on/off state for every toggleable module. */
export type OrgFeatureFlags = Record<OrgModuleKey, boolean>;

// ─── Operating modes ──────────────────────────────────────────────────────────

export const OPERATING_MODES = ['school', 'club'] as const;

export type OperatingMode = (typeof OPERATING_MODES)[number];

/** Everything on — the default for a new org and for any DB without 0047. */
export const ALL_MODULES_ENABLED: OrgFeatureFlags = Object.freeze({
  training: true,
  maintenance: true,
  billing: true,
  booking: true,
  portal: true,
  reports: true,
  auto_schedule: true,
  messages: true,
});

/**
 * Mode presets. 'club' is the small-flying-club starting point: no instruction
 * records, no public booking inbox, no auto-scheduler — squawks, dues/invoices,
 * the member portal, and reports stay on. Every flag remains individually
 * editable after the preset is applied.
 */
export const OPERATING_MODE_PRESETS: Record<OperatingMode, OrgFeatureFlags> = Object.freeze({
  school: ALL_MODULES_ENABLED,
  club: Object.freeze({
    training: false,
    maintenance: true,
    billing: true,
    booking: false,
    portal: true,
    reports: true,
    auto_schedule: false,
    messages: true,
  }),
});

// ─── Display metadata (used by the settings/setup UI) ─────────────────────────

export const ORG_MODULE_META: Record<OrgModuleKey, { label: string; description: string }> =
  Object.freeze({
    training: {
      label: 'Training',
      description: 'Courses, enrollments, and instructor lesson records.',
    },
    maintenance: {
      label: 'Maintenance',
      description: 'Squawks, grounding, work orders, and maintenance-due reminders.',
    },
    billing: {
      label: 'Billing',
      description: 'Invoices, member balances, block time, point of sale, and QuickBooks export.',
    },
    booking: {
      label: 'Public booking requests',
      description: 'The public request page and the staff triage inbox.',
    },
    portal: {
      label: 'Member portal',
      description: 'Self-service reservations, balances, and documents for members.',
    },
    reports: {
      label: 'Reports & activity',
      description: 'Operational reports and the audit activity feed.',
    },
    auto_schedule: {
      label: 'Auto-scheduler',
      description: 'The demand-based automatic scheduling planner.',
    },
    messages: {
      label: 'Messages',
      description: 'Operator announcements to members.',
    },
  });

export const OPERATING_MODE_META: Record<OperatingMode, { label: string; description: string }> =
  Object.freeze({
    school: {
      label: 'Flight school / FBO',
      description: 'Every module on: training records, public booking, auto-scheduling, the works.',
    },
    club: {
      label: 'Small flying club',
      description:
        'A leaner setup for member-owned clubs: scheduling, squawks, dues, and the member portal, without instruction records or a public booking inbox. Turn any module back on whenever you need it.',
    },
  });

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Type guard for a module key. */
export function isOrgModuleKey(value: string): value is OrgModuleKey {
  return (ORG_MODULES as readonly string[]).includes(value);
}

/** Type guard for an operating mode. */
export function isOperatingMode(value: string): value is OperatingMode {
  return (OPERATING_MODES as readonly string[]).includes(value);
}

/**
 * Merge a partial flag update over a base — unknown keys are ignored, missing
 * keys keep the base value. Pure; never mutates its inputs.
 */
export function mergeFeatureFlags(
  base: OrgFeatureFlags,
  patch: Partial<OrgFeatureFlags>,
): OrgFeatureFlags {
  const merged = { ...base };
  for (const key of ORG_MODULES) {
    const v = patch[key];
    if (typeof v === 'boolean') merged[key] = v;
  }
  return merged;
}
