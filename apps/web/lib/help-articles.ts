/**
 * lib/help-articles.ts — Static content + pure helpers for the Help /
 * knowledge-base surface (Slice P1.8, docs/ROADMAP.md).
 *
 * WHY THIS EXISTS
 *   AeroOps is free software; the founder supports every operator solo. A
 *   self-serve help center is the thing that lets that scale — see the
 *   ROADMAP.md P1.8 line item.
 *
 * CONTENT RULE (load-bearing): every article describes a feature that is
 *   ACTUALLY SHIPPED, described accurately from its build spec
 *   (docs/specs/*.md). Nothing here is aspirational or invented. Where a
 *   feature carries a compliance framing (grounding, squawks, maintenance-due,
 *   training progress, lesson signatures, civil twilight), the article keeps
 *   the same "operator data, not an FAA determination" framing used
 *   throughout the app — kept light, not a wall of legal text.
 *
 * PURE DATA MODULE — zero DOM/Next.js imports, mirrors lib/nav.ts. Safe to
 *   import from server components, client components, and unit tests alike.
 *
 * STRUCTURE
 *   HELP_CATEGORIES — the fixed, ordered category list shown on the hub.
 *   HELP_ARTICLES   — the flat article list; each article names its category
 *                      by id (validated by the __tests__ sanity suite).
 *   Pure helpers: getArticleBySlug, articlesInCategory, searchHelpArticles.
 *
 * MAINTAINABILITY: articles are simple data (title/summary/body blocks), not
 *   one-off React components, so adding an article is a data edit, not a new
 *   file. Body blocks are a tiny tagged union — paragraph / bullet list /
 *   callout note — rendered generically by the article page.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type HelpCategoryId =
  | 'getting-started'
  | 'scheduling-dispatch'
  | 'maintenance'
  | 'training-records'
  | 'billing-payments'
  | 'quickbooks'
  | 'people-fleet'
  | 'mobile-app'
  | 'account-data';

export interface HelpCategory {
  id: HelpCategoryId;
  label: string;
  description: string;
}

/** A tiny tagged union for article body content — keeps articles data, not JSX. */
export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  /** A short, load-bearing callout — used for the "operator data, not an FAA
   *  determination" framing and similar compliance-adjacent notes. */
  | { kind: 'note'; text: string };

export interface HelpArticle {
  slug: string;
  title: string;
  category: HelpCategoryId;
  /** One-line summary shown on the hub + used by search. */
  summary: string;
  body: readonly HelpBlock[];
}

// ─── Categories (fixed order — the hub renders in this order) ────────────────

export const HELP_CATEGORIES: readonly HelpCategory[] = [
  {
    id: 'getting-started',
    label: 'Getting started',
    description: 'Roles, permissions, and setting up your organization.',
  },
  {
    id: 'scheduling-dispatch',
    label: 'Scheduling & dispatch',
    description: 'Reservations, the board, recurring bookings, and check-out/in.',
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    description: 'Squawks, grounding, work orders, and due reminders.',
  },
  {
    id: 'training-records',
    label: 'Training records',
    description: 'Courses, lessons, enrollments, and instructor sign-off.',
  },
  {
    id: 'billing-payments',
    label: 'Billing & payments',
    description: 'Invoices, the ledger, online payments, dues, and counter sales.',
  },
  {
    id: 'quickbooks',
    label: 'QuickBooks',
    description: 'Connecting QuickBooks Online and exporting invoices.',
  },
  {
    id: 'people-fleet',
    label: 'People & fleet',
    description: 'Your roster, member tags, aircraft records, and documents.',
  },
  {
    id: 'mobile-app',
    label: 'The mobile app',
    description: 'Using the AeroOps iOS app.',
  },
  {
    id: 'account-data',
    label: 'Account & data',
    description: 'Notifications, the activity feed, the portal, and reports.',
  },
] as const;

// ─── Articles ─────────────────────────────────────────────────────────────────

export const HELP_ARTICLES: readonly HelpArticle[] = [
  // ── Getting started ──────────────────────────────────────────────────────
  {
    slug: 'welcome-to-aeroops',
    title: 'Welcome to AeroOps',
    category: 'getting-started',
    summary: 'What AeroOps does and how the pieces fit together.',
    body: [
      { kind: 'p', text: 'AeroOps is one connected system for a flight school, club, or FBO: scheduling and dispatch, maintenance tracking, training records, billing and payments, and reporting, plus a public booking page and a self-service portal for students and renters.' },
      { kind: 'p', text: 'Every organization ("tenant") gets its own isolated data — your reservations, aircraft, members, and records are never visible to another operator, even though everyone shares the same app.' },
      { kind: 'p', text: 'The left-hand sidebar is your home base. What you see there depends on your role — a mechanic sees Fleet and Maintenance; an accountant sees Dashboard, Billing, and Reports; students and renters land in the Portal. See "Roles and permissions" for the full breakdown.' },
      { kind: 'p', text: 'This Help center only documents features that are actually built and turned on. If something below isn’t visible in your sidebar, your role or your operator’s configuration doesn’t include it yet.' },
    ],
  },
  {
    slug: 'roles-and-permissions',
    title: 'Roles and permissions',
    category: 'getting-started',
    summary: 'What each of the eight roles can see and do.',
    body: [
      { kind: 'p', text: 'AeroOps has eight roles: owner, manager, dispatcher, CFI, mechanic, accountant, renter, and student. An owner or manager assigns roles from the People page.' },
      { kind: 'ul', items: [
        'Owner / Manager — full access: scheduling, dispatch, maintenance, training, billing, people, fleet, reporting, and org settings.',
        'Dispatcher — scheduling, dispatch, maintenance, people, training, and the booking-requests inbox, but not billing or org settings.',
        'CFI — scheduling, dispatch, training records (including lesson sign-off), people, maintenance (view + squawks), and reports.',
        'Mechanic — Fleet and Maintenance only (work orders, squawks, grounding).',
        'Accountant — Dashboard, Billing (invoices, QuickBooks), and Reports.',
        'Renter / Student — the read-only self-service Portal only (their own reservations, training progress, and billing).',
      ] },
      { kind: 'note', text: 'Hiding a link in the sidebar is a convenience, not the security boundary — every action is re-checked on the server against your role, so directly visiting a URL you don’t have access to is refused there too.' },
    ],
  },
  {
    slug: 'setting-up-public-booking',
    title: 'Setting up your public booking page',
    category: 'getting-started',
    summary: 'Let prospects request a discovery flight or intro lesson from your website.',
    body: [
      { kind: 'p', text: 'Every organization gets a public lead-capture page at /book/[your-org-slug]. Anyone can submit a request — name, contact info, a preferred aircraft type (free text), and a requested time window — without creating an account.' },
      { kind: 'note', text: 'This is a REQUEST, not an instant booking. No reservation is created, no money changes hands, and your fleet or schedule is never exposed publicly — the page only ever shows your organization’s name.' },
      { kind: 'p', text: 'Requests land in your Booking requests inbox (owner, manager, and dispatcher). From there, staff pick a real tail number and time and convert the request into an actual reservation — see "Triaging public booking requests".' },
      { kind: 'p', text: 'Share the /book/ link on your website or social profiles. There’s nothing to configure to turn it on — it’s live for every organization by default.' },
    ],
  },
  {
    slug: 'importing-from-flight-circle',
    title: 'Importing your roster and fleet from Flight Circle',
    category: 'getting-started',
    summary: 'Bring your members and aircraft over from another provider with a CSV.',
    body: [
      { kind: 'p', text: 'From Org settings, use "Import from Flight Circle" to upload a members export (from your old provider’s Reports → Downloads screen) or an aircraft/fleet export.' },
      { kind: 'p', text: 'You map CSV columns to AeroOps fields and see a full preview — nothing is created until you confirm the import.' },
      { kind: 'ul', items: [
        'Members import as roster entries via the same path as adding a member by hand. They start with the least-privileged renter role — promote anyone who needs more access afterward from People.',
        'Imported members do not get a login automatically; that’s a separate step your operator handles later.',
        'Financial/ledger history is not part of this importer — it brings over roster and fleet only.',
      ] },
    ],
  },

  // ── Scheduling & dispatch ────────────────────────────────────────────────
  {
    slug: 'reservations-and-the-board',
    title: 'Reservations and the dispatch board',
    category: 'scheduling-dispatch',
    summary: 'Book aircraft and instructors and see the whole day at a glance.',
    body: [
      { kind: 'p', text: 'The Reservations page books time on a resource (aircraft, instructor, etc.). AeroOps checks for overlaps automatically — a resource can’t be double-booked.' },
      { kind: 'p', text: 'Booking policies (if your operator has set any) are checked at the same time — maximum duration, how far in advance you can book, minimum lead time, and blackout windows. A request that violates one is refused with a specific reason, not a generic error.' },
      { kind: 'p', text: 'The Board shows one day at a time across every resource, so dispatch can see the whole operation — who’s flying what, when — in one view.' },
      { kind: 'p', text: 'If your operator has configured a home-base location, new reservations also show a simple day/night indicator based on civil twilight for that day and time.' },
      { kind: 'note', text: 'The day/night indicator is astronomical calculation and operator configuration — it is not a computed FAA night-currency (§61.57) determination. A pilot still confirms their own currency.' },
    ],
  },
  {
    slug: 'recurring-reservations',
    title: 'Setting up recurring reservations',
    category: 'scheduling-dispatch',
    summary: 'Book a weekly lesson or standing block without repeating yourself.',
    body: [
      { kind: 'p', text: 'When creating a reservation, choose "Repeat" to generate a weekly series. Every occurrence is checked individually against conflicts and booking policies — a slot that would conflict is skipped and reported, not silently dropped or force-booked.' },
      { kind: 'p', text: 'Series occurrences correctly handle daylight-saving transitions, so a "every Tuesday at 6pm" series stays at 6pm local time year-round.' },
      { kind: 'p', text: 'Cancelling a series cancels the remaining future occurrences; past occurrences are left alone.' },
    ],
  },
  {
    slug: 'rescheduling-drag-and-drop',
    title: 'Rescheduling with drag-and-drop',
    category: 'scheduling-dispatch',
    summary: 'Move a reservation on the board without re-typing anything.',
    body: [
      { kind: 'p', text: 'On the Board, drag a reservation to a new time slot (or use the Move dialog) to reschedule it.' },
      { kind: 'p', text: 'A reschedule re-runs the full conflict and policy check on the new time. If the new slot isn’t valid, the original reservation is left exactly where it was — a rejected reschedule never leaves you with no reservation at all.' },
    ],
  },
  {
    slug: 'auto-scheduler',
    title: 'Using the auto-scheduler',
    category: 'scheduling-dispatch',
    summary: 'Let AeroOps propose a batch of reservations that fit your constraints.',
    body: [
      { kind: 'p', text: 'Auto-schedule takes a list of demand (who needs time on what, roughly when) and proposes a batch of non-conflicting reservations that respect your booking policies, grounding, and twilight settings.' },
      { kind: 'p', text: 'You always see a full preview before anything is created — nothing is booked until you confirm.' },
      { kind: 'p', text: 'Every proposal that’s committed goes through the exact same booking checks as a manually created reservation — the optimizer has no special path around the rules.' },
    ],
  },
  {
    slug: 'dispatch-checkout-checkin',
    title: 'How dispatch check-out and check-in work',
    category: 'scheduling-dispatch',
    summary: 'Releasing an aircraft, recording Hobbs/tach, and closing out the flight.',
    body: [
      { kind: 'p', text: 'Dispatch ("check-out") releases an aircraft for a reservation: pick the pilot and record the Hobbs (and tach, if tracked) reading at check-out. Only one dispatch can be open per aircraft at a time.' },
      { kind: 'p', text: 'Check-in ("check-out") records the ending Hobbs/tach reading and closes the ticket. Flight time is derived automatically from the Hobbs difference.' },
      { kind: 'p', text: 'If an aircraft is grounded, dispatch is blocked outright — you cannot check an aircraft out while it’s grounded. If your operator has set eligibility requirements (e.g. a tag a pilot needs for a specific aircraft), dispatch checks those too.' },
      { kind: 'p', text: 'Made a mistake at check-out? Void the open ticket instead of closing it — that frees the aircraft without a bogus flight-time record.' },
      { kind: 'note', text: 'Dispatch and grounding are operational tools your operator uses to run the flight line, not a computed Part 91/43 airworthiness or currency determination.' },
    ],
  },
  {
    slug: 'booking-requests-inbox',
    title: 'Triaging public booking requests',
    category: 'scheduling-dispatch',
    summary: 'Turn a website lead into a real reservation.',
    body: [
      { kind: 'p', text: 'Owners, managers, and dispatchers see a Booking requests inbox for leads submitted through the public /book/ page.' },
      { kind: 'p', text: 'To convert a request, pick a real tail number and a time, and AeroOps creates the reservation through the exact same booking checks (conflicts, policies, grounding, twilight) as any other reservation. If the checks fail, nothing is created and the request stays open for another attempt.' },
      { kind: 'p', text: 'A request can only ever be converted once — a second attempt on an already-converted request is refused rather than double-booking.' },
    ],
  },
  {
    slug: 'calendar-feeds',
    title: 'Subscribing to your schedule in Apple/Google Calendar',
    category: 'scheduling-dispatch',
    summary: 'See your AeroOps reservations alongside your other calendars.',
    body: [
      { kind: 'p', text: 'You can subscribe to a live, auto-refreshing feed of your own reservations (as booker or dispatched pilot) from any calendar app that supports "subscribe to URL" (Apple Calendar, Google Calendar, Outlook).' },
      { kind: 'p', text: 'Anyone with Fleet access can also get a feed scoped to one aircraft — handy for a shared shop calendar.' },
      { kind: 'p', text: 'The feed covers a rolling window of recent history plus the near future, and refreshes automatically whenever your calendar app checks it — there’s nothing to re-download.' },
    ],
  },

  // ── Maintenance ──────────────────────────────────────────────────────────
  {
    slug: 'squawks-and-grounding',
    title: 'Squawks and how grounding blocks dispatch',
    category: 'maintenance',
    summary: 'Report a discrepancy and understand what grounding actually does.',
    body: [
      { kind: 'p', text: 'A squawk is a reported discrepancy against an aircraft — open, deferred, or resolved, with a severity level. Anyone with maintenance access can report one.' },
      { kind: 'p', text: 'Grounding is a separate, explicit action staff take on an aircraft — reporting a squawk never automatically grounds it, even a squawk marked severity "grounding". A person decides to ground.' },
      { kind: 'p', text: 'Once grounded, a new reservation on that aircraft shows a warning but is still allowed (so you can plan ahead); dispatch (check-out) is hard-blocked until the aircraft is ungrounded.' },
      { kind: 'note', text: 'Grounding and squawks are operator-entered tracking data, not a computed Part 91/43 airworthiness determination — a mechanic or IA still makes that call.' },
    ],
  },
  {
    slug: 'work-orders',
    title: 'Work orders and returning an aircraft to service',
    category: 'maintenance',
    summary: 'Track a repair job from open to complete and lift a grounding in one step.',
    body: [
      { kind: 'p', text: 'A work order tracks a maintenance job on an aircraft — open → in progress → completed (or cancelled) — and can optionally be linked to a squawk it’s addressing.' },
      { kind: 'p', text: 'Completing a work order is write-once (a sign-off can’t be silently edited afterward). If it’s linked to the squawk that caused a grounding, you can resolve the squawk and lift the grounding in the same action — the "return to service" step.' },
      { kind: 'note', text: 'A work-order sign-off is an operator maintenance record, not an A&P/IA certification or an electronic signature under any FAA rule.' },
    ],
  },
  {
    slug: 'maintenance-due-reminders',
    title: 'Maintenance-due reminders',
    category: 'maintenance',
    summary: 'Track hours- or date-based maintenance items before they’re overdue.',
    body: [
      { kind: 'p', text: 'Set up maintenance items per aircraft with an hours-based or date-based threshold (e.g. "oil change every 50 hours", "annual due by a date"). AeroOps compares the threshold to the aircraft’s last-recorded meter or a date and buckets each item as OK, due soon, overdue, or unknown.' },
      { kind: 'p', text: 'These show up on the dashboard and on the aircraft’s Fleet page as a heads-up, so nothing slips through the cracks.' },
      { kind: 'note', text: 'This is operator-entered tracking data and simple arithmetic — not a computed Part 43 / §91.409 inspection-due determination. A mechanic or IA still makes the airworthiness call.' },
    ],
  },

  // ── Training records ─────────────────────────────────────────────────────
  {
    slug: 'training-hub',
    title: 'Courses, lessons, and enrollments',
    category: 'training-records',
    summary: 'Build a course, enroll a student, and track lesson-by-lesson progress.',
    body: [
      { kind: 'p', text: 'Owners, managers, and CFIs define courses made up of ordered lessons (e.g. a Private Pilot syllabus). Enroll a member in a course to start tracking their progress against it.' },
      { kind: 'p', text: 'Instructors log a lesson record after each session. A lesson record is write-once — a correction is a new, dated entry, never a silent edit of history.' },
      { kind: 'p', text: 'Progress is shown as a simple ratio of lessons covered so far, both on the course detail page and as a summary card on a student’s People profile.' },
      { kind: 'note', text: 'Course content, grading, and progress are operator- and instructor-defined free text and simple content-coverage ratios — not a computed Part 61/141 completion, stage, or currency determination.' },
    ],
  },
  {
    slug: 'lesson-signatures',
    title: 'Lesson records and instructor e-signature',
    category: 'training-records',
    summary: 'How an instructor signs off a lesson record.',
    body: [
      { kind: 'p', text: 'A CFI can sign a lesson record — the signature captures who signed, when, what they attested to (free text), and a tamper-evident hash of exactly what was signed. A signed record can be voided (a tombstone, never edited) but never silently changed.' },
      { kind: 'note', text: 'This attestation artifact is NOT an FAA-recognized digital/electronic signature and is NOT a §61.51/§61.65 or Part 141 endorsement of record. It records who attested to what and when — it computes no training-completion, stage, graduation, or currency determination. A human still makes every regulatory call.' },
    ],
  },

  // ── Billing & payments ───────────────────────────────────────────────────
  {
    slug: 'how-invoices-are-generated',
    title: 'How an invoice is generated from a Hobbs reading',
    category: 'billing-payments',
    summary: 'From a closed dispatch ticket to a draft invoice.',
    body: [
      { kind: 'p', text: 'When a dispatch ticket closes, the derived flight time (from the Hobbs difference) can be turned into a draft invoice against your operator’s rate schedule (wet/dry hourly, instruction, or a flat rate). Every dollar amount is computed in integer cents — never floating-point — so totals always add up exactly.' },
      { kind: 'p', text: 'A draft invoice can be reviewed and edited before it’s finalized. Finalizing (or voiding) is a deliberate, explicit step — invoices are never silently created or changed.' },
      { kind: 'p', text: 'Finalizing an invoice posts one debit to the member’s ledger automatically — see "The ledger, balances, and manual payments".' },
      { kind: 'note', text: 'A correction to a dispatch meter reading is its own append-only record, never a silent edit of the original — so a billing dispute always has a clean history to point to.' },
    ],
  },
  {
    slug: 'ledger-and-balance',
    title: 'The ledger, balances, and manual payments',
    category: 'billing-payments',
    summary: 'Where a member’s balance comes from and how to record cash or check.',
    body: [
      { kind: 'p', text: 'Every member has a ledger: an append-only history of debits (invoices) and credits (payments). Balance is always calculated from that history, never stored separately — so it can’t drift out of sync with the entries behind it.' },
      { kind: 'p', text: 'Staff with billing access can log a manual payment (check, cash, an external payment) — it posts as a credit immediately.' },
      { kind: 'p', text: 'If your operator has turned on a minimum-balance check, dispatch can require a member to be above that balance before checking out — this is an operator-configured threshold, not automatic collections.' },
    ],
  },
  {
    slug: 'online-payments-and-autopay',
    title: 'Online self-pay and autopay',
    category: 'billing-payments',
    summary: 'Let members pay from the portal and opt in to automatic payment.',
    body: [
      { kind: 'p', text: 'From the Portal’s Billing page, a member can save a payment method and pay an invoice directly. Card/bank details are entered through Stripe’s own hosted element and never touch AeroOps’s servers directly.' },
      { kind: 'p', text: 'A member can opt in to autopay: once enabled, finalizing an invoice for that member automatically charges the saved payment method off-session. Each charge is protected against being triggered twice for the same invoice.' },
      { kind: 'p', text: 'A ledger credit is only ever posted once the payment is independently confirmed successful — never optimistically, and never based on a client-side signal alone.' },
    ],
  },
  {
    slug: 'recurring-dues',
    title: 'Recurring dues billing',
    category: 'billing-payments',
    summary: 'Bill membership dues on a schedule without double-billing.',
    body: [
      { kind: 'p', text: 'Set up a dues schedule for a member (an amount and a recurring period) and AeroOps generates one invoice per period automatically. Running the same period twice never creates a duplicate invoice — it’s a hard, structural guarantee, not just an application check.' },
      { kind: 'p', text: 'A dues invoice for an autopay member is charged the same way as any other invoice — finalizing it triggers the off-session charge.' },
    ],
  },
  {
    slug: 'counter-sales-pos',
    title: 'Counter sales (non-flight items)',
    category: 'billing-payments',
    summary: 'Sell a headset, chart, or fuel add-on outside of a dispatch.',
    body: [
      { kind: 'p', text: 'A counter sale is a quick invoice for things that aren’t derived from a flight — merchandise, a chart, fuel, an instructional add-on — using your operator’s product catalog or a one-off ad-hoc line.' },
      { kind: 'p', text: 'A counter sale is billed to an existing member — there’s no separate "guest" checkout today, since every invoice and the ledger behind it needs a member account to bill against.' },
      { kind: 'p', text: 'From there it’s a normal invoice: it posts to the member’s ledger and can be paid or auto-charged the same as any other invoice.' },
    ],
  },
  {
    slug: 'pilot-logbook',
    title: 'The pilot logbook',
    category: 'billing-payments',
    summary: 'A derived, read-only flight history with CSV export.',
    body: [
      { kind: 'p', text: 'The logbook is a read-only view built from your closed dispatch tickets — date, aircraft, and derived flight time — with a CSV export for your own records.' },
      { kind: 'p', text: 'It reads the raw closed-ticket meters, not any later billing correction, so treat it as a convenience flight history, not a billing or legal logbook of record.' },
    ],
  },

  // ── QuickBooks ───────────────────────────────────────────────────────────
  {
    slug: 'connecting-quickbooks',
    title: 'Connecting QuickBooks Online',
    category: 'quickbooks',
    summary: 'Authorize AeroOps to push invoices into your QBO company file.',
    body: [
      { kind: 'p', text: 'From Org settings, the QuickBooks card walks an owner or manager through connecting your QuickBooks Online company file via QuickBooks’ own sign-in and consent screen.' },
      { kind: 'p', text: 'Once connected, set up an account mapping: which QuickBooks item/account each kind of invoice line (wet-hourly, dry-hourly, instruction, flat, or other) should post to. A line whose kind has no mapping is refused as a whole export rather than lumped into the wrong account.' },
      { kind: 'p', text: 'You can disconnect at any time from the same card.' },
    ],
  },
  {
    slug: 'exporting-invoices-to-quickbooks',
    title: 'Exporting invoices to QuickBooks',
    category: 'quickbooks',
    summary: 'Push a finalized invoice, with each line item mapped to its own account.',
    body: [
      { kind: 'p', text: 'From an invoice’s detail page (once it’s finalized), use "Export to QuickBooks" to push it as a QuickBooks invoice — each AeroOps line item becomes its own line, mapped to your configured account.' },
      { kind: 'p', text: 'Exporting the same invoice twice never creates a duplicate in QuickBooks — it’s idempotent, and you can always see the last 20 export attempts (success or error) on the settings card.' },
      { kind: 'note', text: 'This is a one-way, invoice-record export you trigger per invoice. AeroOps never reads anything back from QuickBooks (no two-way sync, no payment reconciliation) and never touches your QuickBooks payment records.' },
    ],
  },

  // ── People & fleet ───────────────────────────────────────────────────────
  {
    slug: 'managing-people',
    title: 'Managing your roster and member tags',
    category: 'people-fleet',
    summary: 'Add members, set roles and status, and use free-text tags.',
    body: [
      { kind: 'p', text: 'The People page lists everyone at your organization with their role, status, and any tags. Adding someone here creates a roster entry — it does not create a login on its own.' },
      { kind: 'p', text: 'A member’s detail page shows the reservations they’ve booked, flights they’ve been dispatched as pilot, and their training progress in one place.' },
      { kind: 'p', text: 'Tags are free text your operator defines (e.g. "night-qualified", "checked out: complex") and can be used by a booking eligibility rule on an aircraft. There’s a built-in guard against removing the last owner and against deactivating your own account.' },
      { kind: 'note', text: 'Tags are operator free text, not a computed FAA currency, medical, or Part 61/141 determination.' },
    ],
  },
  {
    slug: 'fleet-and-aircraft-detail',
    title: 'Aircraft detail pages',
    category: 'people-fleet',
    summary: 'Everything about one tail number in one place.',
    body: [
      { kind: 'p', text: 'The Fleet page lists your aircraft; each detail page rolls up grounding status, open squawks, work orders, recent dispatch history, last-recorded Hobbs/tach meters, and upcoming reservations.' },
      { kind: 'p', text: 'Owners and managers edit identity details (make/model/year/serial/home base) here; every edit is audited.' },
    ],
  },
  {
    slug: 'document-storage',
    title: 'Storing documents (medicals, insurance, POHs)',
    category: 'people-fleet',
    summary: 'Attach files to a member or an aircraft.',
    body: [
      { kind: 'p', text: 'Upload a file and attach it to a member (a medical, a certificate) or an aircraft (insurance, a POH, a receipt) with a free-text category label.' },
      { kind: 'p', text: 'Files are stored in your operator’s own cloud storage, not in the AeroOps database — your browser uploads and downloads the bytes directly via a short-lived, one-time link; the AeroOps server never sees the file contents.' },
      { kind: 'note', text: 'AeroOps stores the file, it doesn’t interpret it — expiry dates or currency status shown elsewhere in the app are never derived from a document you upload here.' },
    ],
  },

  // ── The mobile app ───────────────────────────────────────────────────────
  {
    slug: 'using-the-ios-app',
    title: 'Using the iOS app',
    category: 'mobile-app',
    summary: 'What’s available on your phone today.',
    body: [
      { kind: 'p', text: 'The AeroOps iOS app supports secure login and a read-only view of your schedule. It talks to the same backend as the web app — your data is identical, just viewed on your phone.' },
      { kind: 'p', text: 'Sign-in lasts several hours; you’ll be asked to log in again after that rather than being silently kept signed in indefinitely.' },
      { kind: 'note', text: 'The mobile app is read-only today — booking, dispatch, and other write actions still happen on the web app. Mobile write features are a planned follow-on, not yet available.' },
    ],
  },

  // ── Account & data ───────────────────────────────────────────────────────
  {
    slug: 'notifications-and-email',
    title: 'Notifications and email preferences',
    category: 'account-data',
    summary: 'What triggers an email, and how to turn a given kind on or off.',
    body: [
      { kind: 'p', text: 'AeroOps sends a best-effort email for a handful of events: your reservation is confirmed, a squawk you reported, an aircraft you grounded, your invoice is ready, a payment on your account failed, and a dues invoice is ready.' },
      { kind: 'p', text: 'Manage which of these you receive from the Notifications link in the top header (next to your name) — it’s a personal preference, available to every role.' },
      { kind: 'p', text: 'If email delivery fails for any reason, the action you took (booking, reporting a squawk, etc.) still completes — email is a best-effort notice, never a blocker.' },
    ],
  },
  {
    slug: 'activity-feed',
    title: 'The activity feed and audit trail',
    category: 'account-data',
    summary: 'See recent actions taken across your organization.',
    body: [
      { kind: 'p', text: 'The Activity page is a reverse-chronological feed of actions your team has taken — who did what and when — for staff roles with reporting access.' },
      { kind: 'p', text: 'It’s read-only and never shows raw internal data — only a plain-language summary of the action, so it stays useful without becoming a debugging tool.' },
    ],
  },
  {
    slug: 'student-renter-portal',
    title: 'The student/renter portal',
    category: 'account-data',
    summary: 'What students and renters see when they sign in.',
    body: [
      { kind: 'p', text: 'Students and renters land in the Portal — a read-only view scoped entirely to their own data: their own upcoming and past reservations, their own training progress, and their own billing/ledger.' },
      { kind: 'p', text: 'From the Portal they can also subscribe to their personal calendar feed, download their logbook CSV, and (if your operator has payments turned on) view and pay an invoice or enable autopay.' },
      { kind: 'note', text: 'The portal never shows another member’s data — every read is scoped to the signed-in user, not just filtered in the browser.' },
    ],
  },
  {
    slug: 'reports-and-dashboard',
    title: 'Reports and the ops dashboard',
    category: 'account-data',
    summary: 'Utilization, hours, and what’s happening right now.',
    body: [
      { kind: 'p', text: 'The Dashboard is an "as of now" snapshot (grounded aircraft, open squawks, active fleet, members) alongside recent-days KPIs (flights, hours, reservations) and today’s at-a-glance lists.' },
      { kind: 'p', text: 'Reports adds deeper operational aggregates: utilization and hours by tail, reservations vs. actual flights, and training/maintenance trends over a selectable date range.' },
      { kind: 'note', text: 'These are operational utilization numbers, not billing or airworthiness figures — hours here are for visibility into how your fleet is used, not a computed regulatory record.' },
    ],
  },
] as const;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * getArticleBySlug — find one article by its slug, or undefined if missing.
 * PURE: no DOM, no I/O.
 */
export function getArticleBySlug(
  slug: string,
  articles: readonly HelpArticle[] = HELP_ARTICLES,
): HelpArticle | undefined {
  return articles.find((a) => a.slug === slug);
}

/**
 * articlesInCategory — all articles for a given category id, in their
 * declared HELP_ARTICLES order.
 * PURE: no DOM, no I/O.
 */
export function articlesInCategory(
  categoryId: HelpCategoryId,
  articles: readonly HelpArticle[] = HELP_ARTICLES,
): HelpArticle[] {
  return articles.filter((a) => a.category === categoryId);
}

/**
 * searchHelpArticles — simple case-insensitive substring match over an
 * article's title + summary. Empty/whitespace query returns every article
 * (used as the "no filter applied" state by the client search box).
 * PURE: no DOM, no I/O — safe to call from a client component's render.
 */
export function searchHelpArticles(
  query: string,
  articles: readonly HelpArticle[] = HELP_ARTICLES,
): HelpArticle[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...articles];
  return articles.filter(
    (a) =>
      a.title.toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q),
  );
}
