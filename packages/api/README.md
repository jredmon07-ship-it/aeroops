# @aeroops/api

Server actions / API surface and the clean interfaces that wrap external providers
(Stripe, QuickBooks, weather, SMS/email/push, logbook). Owned by the
`backend-engineer` and `integration-engineer`.

Rules: every tenant call scoped by `org_id`; authz checked on every mutation; input
validated at the boundary; provider details hidden behind interfaces; secrets from
env only. See `THE-BIBLE.md` §3.
