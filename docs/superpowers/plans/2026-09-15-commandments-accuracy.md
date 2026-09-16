# Commandments Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every VarsityHub commandment accurately classified, traceable, and protected against silent drift.

**Architecture:** Keep `docs/COMMANDMENTS.md` as the canonical owner-facing specification, add stable claim IDs and executable parity checks, then use the existing matrix inventory as the whole-codebase coverage layer. Separate verified behavior, product policy, open work, roadmap scope, and historical audit prose.

**Tech Stack:** Markdown, TypeScript/Jest, Node.js test runner, existing matrix audit scripts, npm release scripts.

**Spec:** `docs/superpowers/specs/2026-09-15-commandments-accuracy-design.md`

## Global Constraints

- Preserve unrelated working-tree changes.
- Current claims require source and automated evidence.
- Policy, open, roadmap, and shipped-history entries are not counted as verified current behavior.
- The strict matrix must reach zero drift before any all-claims-accurate statement.
- Device journeys remain explicit release evidence outside component tests.

---

### Task 1: Canonical claims and event-page reconciliation

**Files:**

- Modify: `docs/COMMANDMENTS.md`
- Modify: `server/src/__tests__/commandments-invariants.test.ts`

**Interfaces:**

- Consumes: current event feed/profile implementation.
- Produces: stable `CMD-*` identifiers and parity assertions rejecting stale event wording.

- [ ] Add failing parity assertions for stable claim IDs, live/past post counters, and the shipped profile Events tab.
- [ ] Run the focused suite and confirm those assertions fail for missing documentation.
- [ ] Update the canonical document with classifications and current event behavior.
- [ ] Run the focused suite and confirm it passes.
- [ ] Commit only Task 1 files.

### Task 2: Deterministic matrix runner

**Files:**

- Modify: `scripts/run-matrix-audit.cjs`
- Modify: `scripts/__tests__/matrix-inventory.test.cjs`

**Interfaces:**

- Consumes: `config/matrix-suites.json`.
- Produces: server Jest commands that always include `--watchman=false` and preserve per-suite isolation.

- [ ] Add a failing test against an exported command-builder function.
- [ ] Run the Node test and confirm it fails because the runner has no testable builder.
- [ ] Extract the command builder and add `--watchman=false` to server Jest arguments.
- [ ] Run inventory tests and a representative server suite.
- [ ] Commit only Task 2 files.

### Task 3: Clear current matrix drift

**Files:**

- Modify: `config/matrix-coverage.json`
- Test: `scripts/__tests__/matrix-inventory.test.cjs`

**Interfaces:**

- Consumes: current inventory IDs from `artifacts/matrix-audit/inventory.json`.
- Produces: zero stale/unmapped evidence entries for the current source tree.

- [ ] Classify each of the 14 drift entries with real evidence or an explicit missing-coverage reason.
- [ ] Run strict inventory and confirm drift reaches zero.
- [ ] Review newly exposed coverage gaps without labeling them bugs.
- [ ] Commit the evidence update.

### Task 4: Expand high-risk behavioral parity

**Files:**

- Modify: `server/src/__tests__/commandments-invariants.test.ts`
- Modify or create focused tests under `server/src/__tests__/` and client test directories only where behavior lacks coverage.
- Modify: `docs/COMMANDMENTS.md`

**Interfaces:**

- Consumes: existing event, advertising, payment, ingest, media, privacy, and safety services.
- Produces: an evidence mapping for every current high-risk claim.

- [ ] Add one failing behavioral assertion per uncovered current claim.
- [ ] Implement only missing behavior or reclassify inaccurate prose.
- [ ] Run each focused suite red then green.
- [ ] Run client/server typechecks.
- [ ] Commit by domain so each change is reviewable.

### Task 5: Unified release gate and historical reconciliation

**Files:**

- Modify: `package.json`
- Create: `scripts/verify-commandments.cjs`
- Create: `scripts/__tests__/verify-commandments.test.cjs`
- Modify: historical audit entry points that currently present stale status as current.

**Interfaces:**

- Consumes: parity, matrix, type, navigation, secret, error, authorization, payment, privacy, and minors commands.
- Produces: `npm run verify:commandments` and a commit-stamped status artifact.

- [ ] Add a failing test for required gates and failure propagation.
- [ ] Implement the orchestrator with exact exit-code preservation.
- [ ] Mark historical audits as snapshots and link the canonical status.
- [ ] Run the unified gate and record every unresolved environmental or product failure.
- [ ] Commit the release gate and documentation reconciliation.
