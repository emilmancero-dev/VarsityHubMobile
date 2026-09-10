# Security & architecture audit

Framework 1.0.0 · 2026-09-07T19:29:39.644Z

2 passed · 1 failed · 3 need review

Automated checks have limited scope. Needs-review is unresolved, not passed.

## Direct fetch calls stay in API adapters

**failed · High** (no-fetch-outside-api)

Scanned 455 client files for direct fetch/globalThis.fetch/window.fetch/self.fetch calls. API adapters are api/, apiclient/, src/api/. Aliases and other network libraries require review; local-file and OAuth fetch calls also require architectural review.

- app/components/MatchBanner.tsx:97
- components/BannerUpload.tsx:157
- hooks/useGoogleAuth.ts:244

## Canonical username regex parity

**passed · High** (validation-drift)

Compares literal username regex in canonical client helper and backend username schema only. Length, normalization, email, password and runtime validation remain manual review.

- utils/formUtils.ts: USERNAME*REGEX = /^[a-z0-9*.]+$/
- server/src/routes/auth.ts: username regex = /^[a-z0-9_.]+$/, /^[a-z0-9_.]+$/

## Declared deep-link destinations resolve to Expo routes

**passed · High** (deep-link-coverage)

Resolved 22 declared ROUTE_MAP destinations against 180 Expo source files. This does not prove authorization, parameter safety, or that every screen should be externally linkable.

- utils/deepLinks.ts: all declared destinations resolve

## Webhook replay and concurrent delivery safety

**needs-review · Critical** (webhook-idempotency)

Manual review required: execute duplicate and concurrent delivery tests and inspect unique constraints and transaction boundaries. Presence of a dedup marker cannot prove duplicate-safe writes.

- server/src/routes/payments.ts

## Sensitive admin actions produce durable audit events

**needs-review · High** (audit-log-calls)

Manual review required: exercise each sensitive admin action and verify actor, target and outcome in durable logs, including logger failure. Nearby log calls alone do not prove complete coverage.

- server/src/lib/adminActivityLogger.ts

## Payment state is owned by verified server transitions

**needs-review · Critical** (payment-state-ownership)

Manual review required: tamper with client payment fields and verify backend rejects changes; inspect receipt/signature validation and ownership. Source scanning cannot establish trusted state transitions.

- server/src/routes/payments.ts
