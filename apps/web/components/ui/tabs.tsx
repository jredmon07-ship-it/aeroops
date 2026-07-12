/**
 * Tabs — button-based tab bar (no Radix dependency).
 *
 * Implements role="tablist" / role="tab" / role="tabpanel" ARIA pattern
 * with arrow-key navigation as required by spec §5.
 *
 * Usage:
 *   <Tabs value={activeTab} onValueChange={setActiveTab}>
 *     <TabsList>
 *       <TabsTrigger value="aircraft">Aircraft (3)</TabsTrigger>
 *       <TabsTrigger value="instructors">Instructors (1)</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="aircraft">…</TabsContent>
 *     <TabsContent value="instructors">…</TabsContent>
 *   </Tabs>
 */
'use client';

import * as React from 'react';
import { cn } from './utils';

// ─── Context ──────────────────────────────────────────────────────────────────

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('Tabs sub-components must be used inside <Tabs>');
  return ctx;
}

// ─── Tabs (root) ──────────────────────────────────────────────────────────────

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

function Tabs({ value, onValueChange, children, className }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn('space-y-4', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

// ─── TabsList ─────────────────────────────────────────────────────────────────

interface TabsListProps {
  children: React.ReactNode;
  className?: string;
}

const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ children, className }, ref) => {
    const listRef = React.useRef<HTMLDivElement | null>(null);

    // Arrow-key navigation: left/right move focus between tabs.
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      const node = listRef.current;
      if (!node) return;
      const tabs = Array.from(
        node.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      );
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (current === -1) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        tabs[(current + 1) % tabs.length]?.focus();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        tabs[(current - 1 + tabs.length) % tabs.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        tabs[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        tabs[tabs.length - 1]?.focus();
      }
    };

    return (
      <div
        ref={(el) => {
          listRef.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        role="tablist"
        onKeyDown={handleKeyDown}
        className={cn('flex gap-1 border-b border-slate-200 pb-0 dark:border-slate-800', className)}
      >
        {children}
      </div>
    );
  },
);
TabsList.displayName = 'TabsList';

// ─── TabsTrigger ──────────────────────────────────────────────────────────────

interface TabsTriggerProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

function TabsTrigger({ value, children, className }: TabsTriggerProps) {
  const { value: activeValue, onValueChange } = useTabsContext();
  const isActive = value === activeValue;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={`tabpanel-${value}`}
      id={`tab-${value}`}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onValueChange(value)}
      className={cn(
        'inline-flex items-center justify-center px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 rounded-t-md',
        isActive
          ? 'border-b-2 border-sky-600 text-sky-700 bg-white dark:border-sky-400 dark:text-sky-400 dark:bg-transparent'
          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800',
        className,
      )}
    >
      {children}
    </button>
  );
}

// ─── TabsContent ──────────────────────────────────────────────────────────────

interface TabsContentProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

function TabsContent({ value, children, className }: TabsContentProps) {
  const { value: activeValue } = useTabsContext();
  const isActive = value === activeValue;

  return (
    <div
      role="tabpanel"
      id={`tabpanel-${value}`}
      aria-labelledby={`tab-${value}`}
      hidden={!isActive}
      tabIndex={0}
      className={cn('focus-visible:outline-none', className)}
    >
      {isActive ? children : null}
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
