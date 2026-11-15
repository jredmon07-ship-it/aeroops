/**
 * module-flags.ts — Pure helper for module sections that live on CORE pages
 * (Slice CLUB-MODE). The Portal's "My training", the member Training card and
 * the Reports "Training throughput" section belong to the Training module even
 * though their pages do not, so they follow the module flag themselves.
 *
 * isModuleOn applies the module half of the nav's rule (lib/nav.ts): a module
 * item shows iff the org has that module on. `flags` is the page's own
 * getOrgFeatures result; null means that read failed, which fails soft to on,
 * exactly like the shell nav — a flaky read never hides real records.
 * UI only, like the nav: each section's API read still gates the role.
 *
 * Zero DOM, React, Next.js, or DB imports — unit-tested in (shell)/__tests__.
 */
import type { OrgFeatureFlags, OrgModuleKey } from '@aeroops/core';

export function isModuleOn(
  flags: OrgFeatureFlags | null | undefined,
  module: OrgModuleKey,
): boolean {
  return flags ? flags[module] : true;
}
