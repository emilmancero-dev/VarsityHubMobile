# Publication checkpoint

User requested commit, push, and EAS OTA publication.

## Verified before commit

- Full client suite: 228 suites / 1,631 tests passed.
- Changed backend endpoint suites: 5 suites / 16 tests passed against isolated PostgreSQL.
- Client and server TypeScript passed; EAS build-readiness gate passed with four warnings.
- Local release gate passed through coach approval wiring. Its org-manager verifier initially reached an existing localhost server with a different database; a dedicated embedded server on port 55440 and isolated database on port 55439 passed. The final email configuration audit also passed.
- Release review caught and corrected an event-history cache-shape mismatch: both Profile and Games Attended now cache the raw endpoint response. Two component cases failed before the correction and passed afterward.

## Release hold

- `FLOW-AD-PURCHASE` remains release-blocking because installed-device purchase evidence is missing. No exception or device success is recorded by this checkpoint.
- Installed 1.0.5/1.0.6 journeys have not been verified in this task.
- No OTA, native build, or backend deployment has been issued by this checkpoint. Commit/push is to the repair branch, not a production merge.
- Recent maintained source is on `fork/main` (`emilmancero-dev/VarsityHubMobile`); `origin/main` is 254 commits behind the starting checkout. Existing release documentation records Railway source drift and a direct-CLI deployment requirement. A source push must not be described as a verified Railway deployment.

## Observed production rollback references

- Production channel points to the production EAS branch.
- Runtime 1.0.6: update group `6455a420-423e-41b8-9714-6197855f0b7d`, source `0c3bd3d7`.
- Runtime 1.0.5: update group `c8d98c2f-a68e-469a-b0d8-c53eb94672f8`.
- Both groups list Android and iOS. These are existing releases, not this patch.

Historical reproduction artifacts remain local; they assert pre-fix behavior and are not release tests.
