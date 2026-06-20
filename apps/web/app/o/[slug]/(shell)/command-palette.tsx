/**
 * command-palette.tsx — Global ⌘K command palette (Slice S1.2).
 *
 * Built on @radix-ui/react-dialog (focus-trap / role=dialog / Esc are free).
 * No cmdk dependency.
 *
 * MOUNTING: Once in (shell)/layout.tsx, receives the org slug as a prop.
 *
 * TRIGGER: global keydown (metaKey||ctrlKey)+k → open, OR the "Search" header button.
 *
 * STATES:
 *   closed        — nothing rendered (Dialog closed).
 *   open-empty    — query < 2 → "Type to search…"
 *   loading       — debounced request in flight → "Searching…"
 *   results       — groups returned → grouped list with icons
 *   no-results    — query ≥ 2, empty result → "No matches for '{q}'."
 *   error         — server error → "Search is unavailable right now."
 *
 * A11Y:
 *   - role="dialog" + aria-modal (Radix).
 *   - input aria-label="Search", aria-controls="palette-listbox",
 *     aria-activedescendant pointing to the highlighted option id.
 *   - results region role="listbox", options role="option" + aria-selected.
 *   - aria-live="polite" region announces result counts and no-matches.
 *   - Esc closes + focus returns to trigger (Radix handles this automatically
 *     when the trigger is a Radix DialogTrigger or when returnFocus is used).
 *   - ↑/↓ move a roving highlight over the FLATTENED result list.
 *     DOM focus stays in the input; aria-activedescendant drives screen readers.
 *   - Enter / click → router.push(href) + close.
 *   - Option accessible label: e.g. "Aircraft: N1234 — Cessna 172".
 *
 * KEYBOARD NAV:
 *   ↓ / ↑ moves the highlight (clamped — does not wrap).
 *   Enter → navigate to the highlighted item's href.
 *   Esc → close (Radix).
 *
 * LATEST-QUERY-WINS:
 *   Each debounced call carries an incrementing sequence id.
 *   Stale responses (seqId < currentSeqRef) are discarded.
 *
 * BOUNDARY: imports ONLY from @aeroops/api types — NEVER @aeroops/db.
 */
'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRouter } from 'next/navigation';
import {
  Plane,
  Users,
  Wrench,
  AlertTriangle,
  GraduationCap,
  CalendarDays,
  Search,
} from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { searchOrgAction } from './search-actions';
import type { SearchGroup, SearchResult, SearchResultType } from '@aeroops/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 200;

const TYPE_ICONS: Record<SearchResultType, React.ElementType> = {
  aircraft:    Plane,
  member:      Users,
  work_order:  Wrench,
  squawk:      AlertTriangle,
  course:      GraduationCap,
  reservation: CalendarDays,
};

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * shouldSearch — client min-length gate. Returns true only if query is worth
 * sending to the server. The server enforces the same rule; this is perf-only.
 */
export function shouldSearch(query: string): boolean {
  return query.trim().length >= 2;
}

/**
 * buildHref — prepend the org slug to the server's slug-less path.
 *
 * @param slug - the org slug (e.g. "acme-flight")
 * @param path - the server-returned slug-less path (e.g. "/fleet/abc-123")
 * @returns    - the full app path (e.g. "/o/acme-flight/fleet/abc-123")
 */
export function buildHref(slug: string, path: string): string {
  return `/o/${slug}${path}`;
}

/**
 * flattenGroups — flatten a SearchGroup[] into an ordered flat list for
 * keyboard navigation. Each item carries its group label and an option id.
 */
export interface FlatResult {
  optionId: string;
  groupType: SearchResultType;
  groupLabel: string;
  result: SearchResult;
  href: string;
  accessibleLabel: string;
}

export function flattenGroups(groups: SearchGroup[], slug: string): FlatResult[] {
  const flat: FlatResult[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.results.length; i++) {
      const result = group.results[i]!;
      const secondary = result.secondary ? ` — ${result.secondary}` : '';
      flat.push({
        optionId: `palette-option-${group.type}-${i}`,
        groupType: group.type,
        groupLabel: group.label,
        result,
        href: buildHref(slug, result.path),
        accessibleLabel: `${group.label}: ${result.primary}${secondary}`,
      });
    }
  }
  return flat;
}

/**
 * clampIndex — clamp a roving index to [0, length-1].
 * Returns -1 when length === 0 (no items to highlight).
 */
export function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

// ─── Internal state type ──────────────────────────────────────────────────────

type PaletteState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'results'; groups: SearchGroup[] }
  | { kind: 'no-results'; query: string }
  | { kind: 'error' };

// ─── CommandPalette ───────────────────────────────────────────────────────────

interface CommandPaletteProps {
  /** The org URL slug — used to build full hrefs from server slug-less paths. */
  slug: string;
}

export function CommandPalette({ slug }: CommandPaletteProps) {
  const router = useRouter();

  // Open/closed state — controlled so the header button can open it.
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [state, setState] = React.useState<PaletteState>({ kind: 'empty' });
  // Roving highlight index into the flat list (-1 = none)
  const [highlightIdx, setHighlightIdx] = React.useState(-1);

  // Ref to the trigger button so Radix returns focus on close.
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  // Sequence id for latest-query-wins.
  const seqRef = React.useRef(0);

  // Debounce timer.
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flat result list (derived from state.groups).
  const flatResults = React.useMemo<FlatResult[]>(() => {
    if (state.kind !== 'results') return [];
    return flattenGroups(state.groups, slug);
  }, [state, slug]);

  // ── Reset when closed ──────────────────────────────────────────────────────

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery('');
      setState({ kind: 'empty' });
      setHighlightIdx(-1);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, []);

  // ── Global ⌘K / Ctrl+K keydown ────────────────────────────────────────────

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── Search trigger (debounced) ────────────────────────────────────────────

  const runSearch = React.useCallback(
    async (q: string, seq: number) => {
      if (!shouldSearch(q)) {
        setState({ kind: 'empty' });
        setHighlightIdx(-1);
        return;
      }
      setState({ kind: 'loading' });
      setHighlightIdx(-1);
      try {
        const result = await searchOrgAction(q);
        // Drop stale responses.
        if (seq !== seqRef.current) return;
        if ('error' in result) {
          setState({ kind: 'error' });
          return;
        }
        if (result.groups.length === 0) {
          setState({ kind: 'no-results', query: q });
        } else {
          setState({ kind: 'results', groups: result.groups });
        }
      } catch {
        if (seq !== seqRef.current) return;
        setState({ kind: 'error' });
      }
    },
    [],
  );

  const handleQueryChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const q = e.target.value;
      setQuery(q);
      setHighlightIdx(-1);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (!shouldSearch(q)) {
        setState({ kind: 'empty' });
        return;
      }

      setState({ kind: 'loading' });
      const seq = ++seqRef.current;
      debounceRef.current = setTimeout(() => {
        void runSearch(q, seq);
      }, DEBOUNCE_MS);
    },
    [runSearch],
  );

  // ── Keyboard navigation inside the palette ─────────────────────────────────

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx((prev) => clampIndex(prev + 1, flatResults.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx((prev) => clampIndex(prev - 1, flatResults.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = flatResults[highlightIdx];
        if (item) {
          router.push(item.href);
          handleOpenChange(false);
        }
      }
    },
    [flatResults, highlightIdx, router, handleOpenChange],
  );

  // ── Navigate on click ─────────────────────────────────────────────────────

  const handleResultClick = React.useCallback(
    (href: string) => {
      router.push(href);
      handleOpenChange(false);
    },
    [router, handleOpenChange],
  );

  // ── Accessibility: live region announcement ────────────────────────────────

  const liveAnnouncement = React.useMemo(() => {
    if (state.kind === 'results') {
      const total = flatResults.length;
      return total === 1 ? '1 result' : `${total} results`;
    }
    if (state.kind === 'no-results') {
      return `No matches for ${state.query}`;
    }
    return '';
  }, [state, flatResults.length]);

  // ── Highlighted option id (for aria-activedescendant) ─────────────────────

  const activeDescendantId =
    highlightIdx >= 0 && flatResults[highlightIdx]
      ? flatResults[highlightIdx]!.optionId
      : undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Header trigger button ─────────────────────────────────────────── */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Meta+K"
        aria-label="Open search"
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-1.5',
          'text-sm text-slate-400 hover:text-slate-600',
          'border border-slate-200 bg-white/70 hover:bg-white',
          'transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
        )}
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Search</span>
        <kbd
          className="hidden sm:inline-flex items-center gap-0.5 rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-400"
          aria-hidden="true"
        >
          ⌘K
        </kbd>
      </button>

      {/* ── Dialog ───────────────────────────────────────────────────────── */}
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        <DialogPrimitive.Portal>
          {/* Overlay */}
          <DialogPrimitive.Overlay
            className={cn(
              'fixed inset-0 z-50 bg-black/50',
              'data-[state=open]:animate-in data-[state=open]:fade-in-0',
              'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
            )}
          />

          {/* Palette panel — top-aligned (~15% from top) */}
          <DialogPrimitive.Content
            aria-label="Search"
            className={cn(
              // Position: top ~15%, horizontally centred, max-w-xl
              'fixed left-[50%] top-[15%] z-50',
              'w-full max-w-xl translate-x-[-50%]',
              // Architectural corners + shadow
              'rounded-md border border-slate-200 bg-white shadow-overlay',
              // Animation
              'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
              'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
              'duration-150',
              // Layout
              'flex flex-col overflow-hidden',
            )}
          >
            {/* Screen reader title (visually hidden) */}
            <DialogPrimitive.Title className="sr-only">
              Search AeroOps
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Type at least 2 characters to search aircraft, members, work orders, squawks, courses, and reservations.
            </DialogPrimitive.Description>

            {/* ── Search input ──────────────────────────────────────────── */}
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
              <Search
                className="h-4 w-4 shrink-0 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="text"
                role="combobox"
                aria-label="Search"
                aria-expanded={state.kind === 'results'}
                aria-controls="palette-listbox"
                aria-activedescendant={activeDescendantId}
                aria-autocomplete="list"
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Search…"
                value={query}
                onChange={handleQueryChange}
                onKeyDown={handleKeyDown}
                className={cn(
                  'flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400',
                  'outline-none',
                )}
              />
              {/* Esc hint */}
              <kbd
                className="hidden shrink-0 items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-400 sm:flex"
                aria-hidden="true"
              >
                Esc
              </kbd>
            </div>

            {/* ── Results area ──────────────────────────────────────────── */}
            <div className="max-h-[min(28rem,60vh)] overflow-y-auto">
              {/* Empty / type-to-search */}
              {state.kind === 'empty' && (
                <div className="flex items-center justify-center py-10 text-sm text-slate-400">
                  Type to search…
                </div>
              )}

              {/* Loading */}
              {state.kind === 'loading' && (
                <div className="flex items-center justify-center py-10 text-sm text-slate-400">
                  Searching…
                </div>
              )}

              {/* No results */}
              {state.kind === 'no-results' && (
                <div className="flex items-center justify-center py-10 text-sm text-slate-500">
                  No matches for &lsquo;{state.query}&rsquo;.
                </div>
              )}

              {/* Error */}
              {state.kind === 'error' && (
                <div className="flex items-center justify-center py-10 text-sm text-slate-500">
                  Search is unavailable right now.
                </div>
              )}

              {/* Results — grouped */}
              {state.kind === 'results' && (
                <ul
                  id="palette-listbox"
                  role="listbox"
                  aria-label="Search results"
                  className="py-1"
                >
                  {state.groups.map((group) => {
                    const Icon = TYPE_ICONS[group.type] ?? Search;
                    return (
                      <li key={group.type} role="presentation">
                        {/* Group header */}
                        <div className="flex items-center gap-2 px-4 py-2">
                          <Icon
                            className="h-3 w-3 shrink-0 text-slate-400"
                            aria-hidden="true"
                          />
                          <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-400">
                            {group.label}
                          </span>
                        </div>

                        {/* Group results */}
                        {group.results.map((result, resultIdx) => {
                          // Find this result in the flat list to get its index + optionId.
                          const flatItem = flatResults.find(
                            (f) =>
                              f.groupType === group.type &&
                              f.result.id === result.id,
                          );
                          if (!flatItem) return null;
                          const flatIdx = flatResults.indexOf(flatItem);
                          const isHighlighted = flatIdx === highlightIdx;

                          return (
                            <li
                              key={`${group.type}-${result.id}-${resultIdx}`}
                              id={flatItem.optionId}
                              role="option"
                              aria-selected={isHighlighted}
                              aria-label={flatItem.accessibleLabel}
                              onClick={() => handleResultClick(flatItem.href)}
                              onMouseEnter={() => setHighlightIdx(flatIdx)}
                              className={cn(
                                'flex cursor-pointer flex-col gap-0.5 px-4 py-2',
                                'transition-colors',
                                isHighlighted
                                  ? 'bg-brand/8 text-slate-900'
                                  : 'text-slate-700 hover:bg-slate-50',
                              )}
                            >
                              <span className="text-sm font-medium leading-tight">
                                {result.primary}
                              </span>
                              {result.secondary && (
                                <span className="nums text-xs text-slate-400 leading-tight">
                                  {result.secondary}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* ── Aria live region ──────────────────────────────────────── */}
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {liveAnnouncement}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
