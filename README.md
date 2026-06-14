# AeroOps

The modern operating system for flight schools, flying clubs, and FBOs —
multi-tenant SaaS at parity with Flight Schedule Pro, plus a public booking site,
a renter/student portal, FBO fuel/line ops, and a runtime AI layer.

Built by an org chart of Claude Code agents driven from a single conductor session.

---

## What's in this repo

```
.
├── THE-BIBLE.md            # Single source of truth — full product + build spec
├── CLAUDE.md               # Project memory loaded by Claude Code every session
├── .claude/
│   ├── settings.json       # Tool permissions + defaults for the build pipeline
│   ├── agents/             # The "company": 16 role-scoped subagents
│   └── commands/           # Slash commands: /roadmap /spec /build /qa /ship
├── apps/
│   ├── web/                # Next.js (App Router) ops console
│   └── mobile/             # Expo / React Native parity app
└── packages/
    ├── core/               # Domain types + business rules (shared web/mobile)
    ├── db/                 # Drizzle schema + migrations + RLS policies
    └── api/                # Server actions / API surface
```

---

## Run it in Claude Code

1. **Install Claude Code** (if you haven't):

   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. **Open this folder in Claude Code:**

   ```bash
   cd "Workflow - FBO SaaS"
   claude
   ```

   On startup Claude Code loads `CLAUDE.md`, registers the subagents in
   `.claude/agents/`, and the slash commands in `.claude/commands/`. If you add or
   edit agent files later, **restart Claude Code** so they reload.

3. **Drive the build with the loop** (you approve every gate):

   ```
   /roadmap        # CEO proposes the next slice + tickets → you approve
   /spec <ticket>  # Architect returns the build spec → you approve
   /build          # Builders run in dependency order
   /qa             # test-writer → reviewer → compliance-officer
   /ship           # devops migrates/CI, docs-writer logs the changelog
   ```

   Then read the diff, run it locally, merge, demo — and back to `/roadmap`.

---

## Install the app toolchain (Phase 0)

The scaffold uses pnpm workspaces. Once you're ready to have the agents build:

```bash
corepack enable
pnpm install
cp .env.example .env.local   # fill in your keys
```

Fill `.env.local` with your Postgres URL, Auth.js secret, Stripe keys, etc. Never
commit it — `.gitignore` already excludes it.

---

## The rules that never bend

- **Tenant isolation is the whole game** — every tenant query scoped by `org_id`,
  RLS as backstop.
- **PCI stays with Stripe** — never store raw card data.
- **Don't fabricate regulation** — Part 61/141/135 details get flagged `[VERIFY]`
  and routed through the `compliance-officer`.
- **Human gates** — migrations, anything irreversible, anything that sends to a
  customer, anything touching payments.
- **Finish slices, don't widen them** — the CEO agent's prime directive is "no."

See `CLAUDE.md` for the full guardrails and `THE-BIBLE.md` for the complete spec.
