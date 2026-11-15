/**
 * mobile-nav.tsx — Client component: hamburger button + Sheet nav drawer.
 *
 * Rendered in the shell header on small screens (md:hidden).
 * Receives the already-filtered nav items from the server layout
 * so it never needs to call hasCapability itself.
 *
 * Below md the header has no room for its account cluster (Notifications,
 * avatar, email, role, Sign out), so the drawer carries the same items in a
 * footer under the nav list. The nav list scrolls; the footer stays put.
 *
 * Accessibility:
 *   - Trigger has aria-label="Open navigation menu"
 *   - SheetTitle describes the drawer for screen readers
 *   - Nav links close the drawer on click (SheetClose as child)
 *   - Focus moves to the first link when the drawer opens (Radix default)
 *   - The role badge keeps the header's aria-label ("Role: Owner")
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/user-avatar';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetClose,
} from '@/components/ui/sheet';
import type { NavItem } from '@/lib/nav';
import { SignOutButton } from '../sign-out-button';

interface MobileNavProps {
  items: NavItem[];
  currentPath: string;
  orgName: string;
  /** Org slug — for the Notifications link and Sign out. */
  slug: string;
  /** The signed-in user, as the header shows them at md and up. */
  email: string;
  roleLabel: string;
  avatarSrc: string | null;
}

export function MobileNav({
  items,
  currentPath,
  orgName,
  slug,
  email,
  roleLabel,
  avatarSrc,
}: MobileNavProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 md:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle>{orgName}</SheetTitle>
        </SheetHeader>
        <nav aria-label="Mobile navigation" className="min-h-0 flex-1 overflow-y-auto px-4 pt-2">
          <ul className="space-y-1" role="list">
            {items.map((item) => {
              const isActive = currentPath === item.href;
              return (
                <li key={item.href}>
                  <SheetClose asChild>
                    <Link
                      href={item.href}
                      aria-current={isActive ? 'page' : undefined}
                      className={[
                        'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-brand/8 text-brand-ink dark:bg-brand/20 dark:text-blue-200'
                          : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
                      ].join(' ')}
                    >
                      {item.label}
                    </Link>
                  </SheetClose>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ── Account — the header's account cluster, below md ─────────── */}
        <div className="shrink-0 space-y-1 border-t border-slate-200 px-4 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5 px-3 pb-2">
            <UserAvatar name={email} src={avatarSrc} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm text-slate-500 dark:text-slate-400">
              {email}
            </span>
            <Badge variant="secondary" aria-label={`Role: ${roleLabel}`}>
              {roleLabel}
            </Badge>
          </div>
          <SheetClose asChild>
            <Link
              href={`/o/${slug}/notifications`}
              className="block rounded-md px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            >
              Notifications
            </Link>
          </SheetClose>
          <div className="px-3 pt-2">
            <SignOutButton slug={slug} className="w-full" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
