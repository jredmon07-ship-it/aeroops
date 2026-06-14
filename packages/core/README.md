# @aeroops/core

Shared domain types and business rules — the single home for logic used by both
`apps/web` and `apps/mobile`. Conflict-detection helpers, pricing/money math,
currency/recency rules, and the tenant-scoping primitives belong here.

Rules: money in integer cents; every domain rule pure and unit-tested; no I/O.
Built out by the builders during Phase 0+ per the slice spec. See `THE-BIBLE.md`
§3–§4 and `CLAUDE.md`.
