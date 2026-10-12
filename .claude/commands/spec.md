---
description: Architect turns an approved ticket into a build spec (plan mode).
argument-hint: "<ticket title or id>"
---

You are the conductor. Produce the build spec for an approved ticket — do NOT write
implementation code in this step.

Ticket to spec: $ARGUMENTS

Steps:
1. Invoke the **architect** subagent. In the context packet give it: the ticket,
   the relevant sections of THE-BIBLE.md, the current slice from CLAUDE.md, and the
   file paths it should read. Ask for the full spec: data-model delta, API
   contracts, UI states, edge cases, and the test list (note where property-based
   tests are needed).
2. If the ticket is cross-cutting (auth, multi-tenant isolation, new package
   boundary, performance), also invoke the **cto** for the
   architectural decision/ADR, and the **product-designer** if the slice needs
   screen specs.
3. Collect any [VERIFY] flags; if regulation is involved, route them to the
   **compliance-officer** before finalizing.

Present the consolidated spec to the maintainer and STOP for design approval before
any builder runs.
