# Security & Architecture Audit Report

- Framework version: 1.0.0
- Checklist source: `tools/audit/src/features/audit/checklist.json`
- Repository / commit / PR:
- Scope and excluded surfaces:
- Environment and deployment version:
- Reviewer / review timestamp:
- CI run URL and automated report:
- Decision: **NOT ASSESSED** (replace after evidence review)

## Checklist evidence

One row per reviewed item. Leave unverified items unchecked or in-progress. A source scan is not a behavioral pass. Failed items require notes. If framework versions differ, reconcile item IDs and requirements before reusing results.

| Item ID               | Topic / rule type       | Severity     | Status    | Verification evidence / timestamp                 | Notes / reviewer     |
| --------------------- | ----------------------- | ------------ | --------- | ------------------------------------------------- | -------------------- |
| `<canonical-item-id>` | `<topic> / <rule type>` | `<severity>` | unchecked | `<command, test, log or deployment evidence URL>` | `<not yet reviewed>` |

## Flow and threat model

- Trigger, actor and initial state:
- Trust-boundary path (client → API → database → webhook/job → third-party auth/payments → storage → final UI):
- Source of truth for each critical state:
- Auth bypass / privilege escalation / payment spoofing / IDOR:
- Webhook replay / stale cache / deep-link abuse:
- Minor privacy, blocking and consent implications:
- Retry, reversal and cross-replica behavior:

## Finding (repeat for each finding)

### Finding

- Title / finding ID:
- Checklist item ID(s):
- Category (auth bypass, data integrity, etc.):
- Rule type (Audit Steps / Engineering Standards / Business Rules / Release Gates):
- Severity (Critical / High / Medium / Low):
- State (confirmed / needs reproduction / resolved):

### Proof

- Affected file paths and line numbers at the recorded commit:
- Minimal relevant code snippet (redacted):
- Preconditions and actor privileges:
- Reproduction / exploit path, with safe test fixtures:
- Observed output or redacted log / screenshot / test artifact:

### Expected behavior

Describe the invariant and the result that should occur.

### Actual behavior

Describe what the reproduction demonstrates; separate observation from inference.

### Risk

- Exploitability and prerequisites:
- Blast radius / affected data and users:
- Recoverability and integrity impact:
- Uncertainties or unavailable evidence:

### Fix strategy

- Code or configuration changes:
- Before-fix failing reproduction:
- Regression tests and negative cases:
- Verification commands / environment / expected results:
- After-fix actual results and evidence:
- Owner and target date:

### Release risk

- Rollout order and feature flags:
- Migration status and compatibility:
- Rollback triggers, procedure and owner:
- Observability and alert evidence:
- Residual risk and reviewed exception (if any, with expiry):

## Release decision

- Critical/High failed gates (must block):
- Unresolved Critical/High controls (complete review before deciding):
- Medium/Low warnings, owners and due dates:
- Required test, typecheck and lint results:
- Missing files, failed tooling or environment blockers:
- Final decision / reviewer / timestamp:

Attach exported JSON and Markdown plus immutable CI/test evidence. Never include credentials, private user content or unredacted production payloads.
