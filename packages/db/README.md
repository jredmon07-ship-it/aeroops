# @aeroops/db

Drizzle schema + Postgres migrations + Row-Level-Security policies. Owned by the
`schema-engineer`.

Non-negotiables:
- Every tenant-scoped table carries a non-null `org_id` and an RLS policy.
- Control-plane tables (Plan, Subscription, Domain, PlatformUser) are NOT
  org-scoped — keep them separate.
- Audited records (invoices, payments, Hobbs/tach, endorsements, stage checks,
  maintenance sign-offs) are append-only / change-logged.
- Money is integer minor units (cents).
- **Migrations are human-gated** — generate the SQL, then a human reviews before it
  runs. Never auto-apply to a real database.

See `THE-BIBLE.md` §4 for the data-model spine.
