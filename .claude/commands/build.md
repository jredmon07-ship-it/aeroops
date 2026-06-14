---
description: Run the approved slice through the builders in dependency order.
argument-hint: "[optional: ticket title or id]"
---

You are the conductor. Build the approved slice. Slice/ticket: $ARGUMENTS

Only proceed if the architect's spec for this slice has been approved by the
founder. Invoke builders ONE AT A TIME, each with a full context packet (the
ticket + the approved spec + relevant file paths + acceptance criteria) — subagents
start fresh and remember nothing from the previous one.

Dependency order:
1. **schema-engineer** — Drizzle schema + migration + RLS policies (migration is
   staged for human review, not auto-applied).
2. **backend-engineer** — server actions / API / domain logic per the contracts.
3. **scheduling-engineer** — invoke for ANYTHING touching the calendar engine
   (conflict detection, recurrence, availability, the optimizer); it owns that code.
4. **frontend-engineer** — Next.js pages/components/forms for every screen state.
5. **mobile-engineer** — only if mobile is in this slice.
6. **integration-engineer** — Stripe / QuickBooks / weather / SMS-email-push /
   logbook, against sandbox/test modes only.

After each builder, summarize what it produced. When the slice is implemented,
hand off to `/qa`. Do not widen scope beyond the approved spec — if something is
missing, STOP and raise it.
