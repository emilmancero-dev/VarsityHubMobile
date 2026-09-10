# The 12 Audit Commandments

**VarsityHub · Framework v1.0.0 · Evidence before approval**

Audit Steps investigate. Engineering Standards structure. Business Rules protect product invariants. Release Gates decide readiness.

| #   | Rule                                                                                           | What passing looks like                                                                                   |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | [Map the real flow and its threats](AUDIT_FRAMEWORK.md#auth-bypass)                            | Actor → API → database → webhook/job → provider/storage → final state; every trust boundary named.        |
| 2   | [One trusted owner per critical state](AUDIT_FRAMEWORK.md#critical-state)                      | Payment, plan, role, approval and ownership come from server records.                                     |
| 3   | [Backend validation is law](AUDIT_FRAMEWORK.md#validation-drift)                               | Client, server, schema and async inputs compared; drift fixed or explicitly justified.                    |
| 4   | [Every protected action checks authority](AUDIT_FRAMEWORK.md#privilege-escalation)             | Server checks authentication, role, plan and persisted resource ownership; denials produce no writes.     |
| 5   | [Privacy and minor safety fail closed](AUDIT_FRAMEWORK.md#minor-privacy)                       | Missing identity, age, consent or access proof never grants private data or messaging access.             |
| 6   | [Thin routes; shared policy and transport](AUDIT_FRAMEWORK.md#thin-routes)                     | Wrappers delegate; shared helpers and `apiclient/` own reusable logic and networking; state stays narrow. |
| 7   | [Trusted payment confirmation only](AUDIT_FRAMEWORK.md#payment-spoofing)                       | Signed provider evidence controls entitlements; success UI confirms backend state.                        |
| 8   | [Async work survives replay and replicas](AUDIT_FRAMEWORK.md#webhook-replay)                   | Durable dedupe, transactions and shared coordination preserve state through retries and reversals.        |
| 9   | [Navigation and UI fail safely](AUDIT_FRAMEWORK.md#deep-link-abuse)                            | Links validate parameters; loading/error/empty states, double-submit guards and accessible recovery work. |
| 10  | [Caches never preserve revoked access](AUDIT_FRAMEWORK.md#stale-cache)                         | Identity, block, role and payment changes invalidate affected data; authority is rechecked.               |
| 11  | [Every finding needs proof; every fix verification](AUDIT_FRAMEWORK.md#proof-and-verification) | Reproduction, files, expected/actual results, risk, tests and redacted audit evidence are attached.       |
| 12  | [Ship observable, testable and reversible changes](AUDIT_FRAMEWORK.md#reversible-release)      | Relevant checks pass; alerts, migration order, rollback triggers and ownership are documented.            |

**Unchecked is not passed.** Missing evidence stays unresolved. Critical/High failed gates block release; scans alone cannot prove behavioral security.

Full rules and verification: [Audit Framework](AUDIT_FRAMEWORK.md) · [Audit Standard](AUDIT_STANDARD.md) · [Finding Template](../templates/AUDIT_REPORT.md)
