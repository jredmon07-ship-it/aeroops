# Slice S1 — Global search / command palette (⌘K) — build spec

**READ-ONLY, additive, NO schema/migration/money/FAA-determination. Sub-slice S1.1 backend → S1.2 palette UI.**
LOCKED decisions (founder-away; architect recommendations adopted): (1) front door = `requireCapability(session,
'app:access')` then PER-TYPE `hasCapability` scoping — NO new capability; (2) reservations INCLUDED (notes-only
match); (3) squawk results link to the list route (no detail route exists); (4) build on the existing Radix
`dialog.tsx` — do NOT add `cmdk`; (5) `searchOrg` returns a slug-less `path` (e.g. `/fleet/{id}`), the palette
prepends `/o/{slug}`; (6) LIKE wildcards escaped + `ESCAPE '\'`.

## THE LOAD-BEARING REQUIREMENT — per-cap scoping + tenant isolation
A result type appears ONLY if the session holds its read cap; every query is RLS-scoped via
`withSessionOrgContextWithDb` (org_id from session ONLY). Search must NEVER return an entity the role can't already
see, and NEVER cross orgs. Mapping (the gate is the *access* cap, not a manage cap):
| type | cap | path | match fields |
|aircraft|fleet:access|`/fleet/{id}`|tail_number/make/model (kind='aircraft' AND active)|
|member|people:access|`/people/{id}`|app_user.full_name/email (status='active'); primary=full_name??email|
|work_order|maintenance:access|`/maintenance/work-orders/{id}`|title (any status)|
|squawk|maintenance:access|`/maintenance/squawks`|title|
|course|training:access|`/training/{id}`|title|
|reservation|schedule:access|`/schedule/board`|notes (status!='cancelled')|
Student/renter (app:access only) + accountant (app+reporting) → `{groups:[]}`. mechanic → aircraft+work_order+squawk
only. cfi → all six (has all the *access* caps incl. maintenance:access despite lacking maintenance:work_order).

## S1.1 — Backend (`packages/api/src/search/search-org.ts` + pure helpers in `packages/core/src/search/`)
`searchOrg(session,{query})` + `searchOrgWithDb(db,session,{query})`; barrel-export both + types from packages/api index.
Algorithm: (1) `requireCapability(session,'app:access')` front door (null/incomplete → UnauthenticatedError);
(2) zod `{query: z.string().max(200)}` → `q = parsed.query.trim()`; **if q.length<2 → return `{groups:[]}` with NO db
call**; (3) `pattern = '%'+escapeLike(q)+'%'`, prefix `escapeLike(q)+'%'`, BOTH bound params, SQL uses `ILIKE ${pattern}
ESCAPE '\'`; (4) ONE `withSessionOrgContextWithDb`; (5) per type, IF `hasCapability(session,cap)` run its bounded query
(`LIMIT 5`) ELSE skip (no query, no leak) — sequential, deterministic; (6) map rows → `SearchResult {id, primary
(never empty — member→email fallback), secondary|null, path (slug-less)}`; (7) assemble `groups` in FIXED type order
(aircraft,member,work_order,squawk,course,reservation), OMIT empty groups. Ranking per group: `ORDER BY (CASE WHEN
<field> ILIKE ${prefix} ESCAPE '\' THEN 0 ELSE 1 END), lower(<primary>) ASC` (prefix-match first, then alphabetical —
deterministic). Output `SearchOrgResult {groups: SearchGroup[]}` (SearchGroup {type,label,results}). Reads NOT audited.
Pure helpers in `@aeroops/core/src/search/`: `escapeLike(s)` (escape `\`→`\\`, `%`→`\%`, `_`→`\_`, escape-char first) +
the ranking comparator — both PROPERTY-TESTED (escape round-trips/never dangles; ranking total+deterministic+idempotent,
prefix precedes, ties by lower(primary)). NEVER string-interpolate the query — bound `${}` only (injection guard);
escaping is for LIKE-semantics, parameterization for SQL-injection — both apply.

## S1.2 — Web (palette, `(shell)/command-palette.tsx` mounted in the shell layout w/ slug prop; server action `searchOrgAction`)
Server action: `const session=await auth(); return searchOrg(session,{query})` (no REST route). Palette built on Radix
`dialog.tsx` (focus trap/role=dialog/Esc free). Trigger: global keydown `(metaKey||ctrlKey)&&key==='k'` preventDefault
+ a header "Search ⌘K" button. States: closed / open-empty (q<2, "Type to search…") / typing (debounce ~200ms,
latest-query-wins via seq-id/AbortController, client min-2 gate) / loading / results (groups fixed order, lucide icons,
primary bold + secondary muted `.nums`, ↑/↓ roving highlight over the FLATTENED list via aria-activedescendant keeping
input focus, Enter→router.push('/o/'+slug+path)+close, click=same) / no-results (q≥2 empty → "No matches for '{q}'";
a zero-cap role sees THIS, never an error/forbidden) / error ("Search is unavailable right now."). A11y: role=dialog+
aria-modal, listbox/option roles, aria-activedescendant, aria-live count, Esc closes + focus returns to trigger. Design
tokens (architectural corners rounded-sm/md, brand-ink, focus-visible:ring-brand, top-aligned ~15%). Prepend /o/{slug}
to each slug-less path in the UI.

## Edge cases / tests
HEADLINE per-cap scoping (owner=all 6; student/renter/accountant=∅; mechanic=aircraft+WO+squawk only; cfi=all 6;
assert a skipped type runs NO query) + T-ISO (two orgs identical-named entities → org-A returns ONLY org-A per type) +
LIKE escaping (literal `%`/`_` don't wildcard) + injection (`'; DROP…` safe via params) + case-insensitivity + short/
empty/whitespace→∅ no db call + >200 truncated + ≤5/type ≤30 total + member no-name→email + null session→Unauthenticated.
Property tests (REQUIRED, pure helpers in core): escapeLike round-trip/no-dangle; ranking total/deterministic/idempotent/
prefix-precedes/tie-by-lower-primary; bound ≤5per/≤30total. Web: client min-len gate, path interpolation, palette state +
a11y tests. Compliance: light — read-only operator data, no money, no FAA determination, not audited; NO [VERIFY] expected.
