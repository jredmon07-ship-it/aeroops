---
description: Run the quality gates — tests, security/tenant review, compliance.
argument-hint: "[optional: slice or ticket id]"
---

You are the conductor. Run the quality gates on the built slice. Slice: $ARGUMENTS

Invoke in order, each with the spec + the diff/files as context:
1. **test-writer** — cover the architect's happy path and every listed edge case;
   property-based tests for conflict detection and gate logic; tenant-isolation and
   authz tests. Run the suite and report pass/fail.
2. **reviewer** — security + tenant-isolation pass over the diff: org_id scoping,
   RLS intact, authz on every mutation, no secrets, audited
   records, input validation. Returns a fix list by severity.
3. **compliance-officer** — only if the slice touches regulation, training/maintenance
   records, currency, endorsements, or FSDO reporting; resolve every [VERIFY].

Collect all findings. Route fixes back to the relevant builder via `/build`-style
delegation, then re-run the failing gate. Do not proceed to `/ship` until tests
pass and the reviewer (and compliance, if invoked) are clear. Summarize the gate
results for the maintainer.
