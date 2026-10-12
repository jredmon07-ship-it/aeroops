---
description: Stage migrations + CI and update the changelog, then summarize the diff.
argument-hint: "[optional: slice or ticket id]"
---

You are the conductor. Prepare the passed slice to ship. Slice: $ARGUMENTS

Only run after `/qa` is green. Steps:
1. **devops-engineer** — run CI (type-check, lint, test, build). Stage the
   migration and show the SQL + rollback plan. MIGRATIONS ARE HUMAN-GATED: present
   the migration to the maintainer and STOP for explicit approval before it runs
   against any real database. Nothing destructive or irreversible without explicit
   confirmation.
2. **docs-writer** — write the changelog entry and update user/admin/API docs for
   what actually shipped.

Then summarize the full diff for the maintainer: what changed, the migration awaiting
approval, and anything customer-facing that would send (also human-gated). STOP at
the human gate — the maintainer reads the diff, runs it locally, approves the
migration, merges, and demos. Then return to `/roadmap`.
