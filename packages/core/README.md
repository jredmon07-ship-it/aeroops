# @aeroops/core

Shared domain types and business rules — the single home for logic used by both
`apps/web` and `apps/mobile`. Conflict-detection helpers, flight-time math,
civil twilight, the scheduler optimizer, and the tenant-scoping primitives belong here.

Rules: every domain rule pure and unit-tested; no I/O.
Built out by the builders during Phase 0+ per the slice spec. See `THE-BIBLE.md`
§3–§4 and `CLAUDE.md`.
