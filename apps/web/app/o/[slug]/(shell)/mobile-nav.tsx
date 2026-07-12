/**
 * mobile-nav.tsx — Client component: hamburger button + Sheet nav drawer.
 *
 * Rendered in the shell header on small screens (md:hidden).
 * Receives the already-filtered nav items from the server layout
 * so it never needs to call hasCapability itself.
 *
 * Accessibility:
 *   - Trigger has aria-label="Open navigation menu"
 *   - SheetTitle describes the drawer for screen readers
 *   - Nav links close the drawer on click (SheetClose as child)
 *   - Focus moves to the first link when the drawer opens (Radix default)
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetClose,
} from '@/components/ui/sheet';
import type { NavItem } from '@/lib/nav';

interface MobileNavProps {
  items: NavItem[];
  currentPath: string;
  orgName: string;
}

export function MobileNav({ items, currentPath, orgName }: MobileNavProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{orgName}</SheetTitle>
        </SheetHeader>
        <nav aria-label="Mobile navigation" className="px-4 pt-2">
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
      </SheetContent>
    </Sheet>
  );
}
