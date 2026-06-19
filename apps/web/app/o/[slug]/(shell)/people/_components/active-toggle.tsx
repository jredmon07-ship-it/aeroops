/**
 * active-toggle.tsx — Active-only / Show-inactive toggle link.
 *
 * This is a simple Link-based toggle that sets/clears the
 * ?includeInactive=1 search param. No client state needed —
 * the parent page reads the search param server-side.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface ActiveToggleProps {
  slug: string;
  includeInactive: boolean;
}

export function ActiveToggle({ slug, includeInactive }: ActiveToggleProps) {
  const href = includeInactive
    ? `/o/${slug}/people`
    : `/o/${slug}/people?includeInactive=1`;

  return (
    <Button asChild variant="outline" size="sm" aria-pressed={includeInactive}>
      <Link href={href}>
        {includeInactive ? 'Active only' : 'Show inactive'}
      </Link>
    </Button>
  );
}
