# Commandments Accuracy Design

## Purpose

Make every VarsityHub commandment traceable to current behavior, an explicit product decision, or a clearly labeled future requirement. A document may not call itself code-verified when only a subset of its claims has executable evidence.

## Canonical model

`docs/COMMANDMENTS.md` remains the owner-facing specification. Every enforceable claim receives a stable `CMD-*` identifier and one status:

- `CURRENT`: asserted behavior with source and automated evidence.
- `POLICY`: an intentional choice that differs from an older specification.
- `OPEN`: approved behavior that is not implemented consistently.
- `ROADMAP`: future scope that is not presented as current behavior.
- `SHIPPED`: a former UI TODO that has current source and test evidence.

Older audits remain historical evidence and must link readers to the canonical document rather than claim current compliance.

## Phases

1. Reconcile the known event-page drift, introduce stable claim IDs, and extend the parity guard to reject stale wording.
2. Repair the matrix runner so server suites run without Watchman and update evidence for the 14 current drift entries.
3. Expand executable commandment coverage across events, ads/payments, ingest, media, privacy, and safety. Prefer behavioral tests; source-text checks are reserved for constants and wiring invariants.
4. Add a single release command that runs parity, types, navigation, secrets, error disclosure, authorization, payments, privacy, minors, and strict matrix drift checks.
5. Reconcile historical audit documents and publish a generated status report tied to a Git commit and generation time.

## Accuracy rules

- Current claims require a stable ID, implementation evidence, and automated evidence.
- Policy, open, and roadmap entries must never be counted as verified current behavior.
- Matrix coverage gaps remain visible, but they are not called product bugs without a reproducing path.
- Zero matrix drift is required for an all-claims-accurate statement.
- Installed-app journeys remain a separate release check because component tests cannot prove them.

## Verification

Each phase runs its focused tests plus client/server typechecks. The final gate also runs navigation, conflict, error-envelope, secret, authorization, payment, privacy, minors, and strict matrix checks. Reports include the tested commit and do not overwrite failures with optimistic prose.
