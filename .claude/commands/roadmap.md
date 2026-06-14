---
description: CEO (re)prioritizes the backlog and prints the next tickets for approval.
argument-hint: "[optional: a request or area to prioritize]"
---

You are the conductor. Invoke the **ceo** subagent to (re)prioritize the roadmap.

Context for the CEO:
- Read THE-BIBLE.md (full spec) and CLAUDE.md (current phase/slice) first.
- Respect the phased, sliced roadmap in THE-BIBLE.md §10. Do not jump phases.
- Founder input for this run (may be empty): $ARGUMENTS

Ask the CEO to:
1. Confirm or propose the **next slice** to work on, with the user value and which
   Hub it belongs to.
2. Say NO to anything outside the current phase, explicitly.
3. Write the ticket(s) in the standard format: Title · User story
   ("As a <role>, I want <x> so that <y>") · Acceptance criteria · Primary action ·
   Dependencies · Definition of Done.
4. End with a crisp prioritized list for the human to approve.

After the CEO responds, present its prioritized list to the founder and STOP for
approval. Once approved, update the "Current phase / slice" section of CLAUDE.md.
