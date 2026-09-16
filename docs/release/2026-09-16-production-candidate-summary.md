# September 16 production candidate — changes and evidence

## Status

Repair candidate pushed to GitHub, **not yet production-complete**. The isolated worktree preserves the user's original checkout and media-picker edits. [Draft PR #25](https://github.com/emilmancero-dev/VarsityHubMobile/pull/25) holds the candidate; the initial clean push was `27be6cb1d715502e70763333f1408349e27a3fad`. API/web/OTA production publication has not occurred.

## Surgical repairs

- Feed/Discover: independent section loading, viewer-scoped cache, mutation invalidation and active-only polling. Backend pagination bounds query work and preserves privacy filters; both old/new cursor readers remain supported.
- Cursor rollout: legacy writers by default; deploy dual readers, verify old replicas have drained, then enable `POST_PAGE_CURSOR_V2_WRITE_ENABLED=true` on the same candidate. Once new markers exist, rollback must retain dual readers.
- Media: one photo-preparation path; cancellation propagates through preparation/upload. Legacy Android cancellation waits for the encoder to finish without publishing the cancelled result or overlapping another encoder. This is **not** immediate native interruption.
- Linked-post summary: posts linked by both game and event IDs were counted twice. A grouped union counts each post once while retaining the complete visibility predicate, including deleted-content exclusion.
- Shared-link security: inherited public landing pages trusted Host/forwarded headers for clickable URLs. Two tests reproduced unsafe schemes and attacker-controlled destinations. All seven rendering paths now use validated HTTP(S), credential-free `APP_BASE_URL` origins, preserving path/query and existing privacy rules. Invalid configuration safely falls back to the public apex. Seven new regressions and independent review passed; production's existing value was read-only verified as `https://varsityhub.app`.
- Web hydration: defer viewport-only chrome until mount, keep the initial system-theme snapshot identical to server output, and remove the competing tab-root index. Bare tab links still initialize Feed explicitly; actual installed-router tests cover root matching and tab initialization.
- Composer entry: redirects and automatic location prompts are focus-scoped. Guests/unverified users no longer trigger the location prompt while being sent to authentication. Regression failed before the guard, passed afterward; the rebuilt browser now reaches Login successfully.
- Telemetry: preserve the SDK's valid protocol timestamp while continuing to scrub payload properties. Actual SDK batching/flush regression covers this; it does not prove repair of every previously queued malformed analytics event.
- Release tooling: isolated dependencies; patched eligible lockfile vulnerabilities; CI Redis prerequisite; owned, random-port local verifier; manual web/OTA dispatch; clean-tree OTA wrapper pins each runtime after production environment loading and publishes source maps once.
- Test isolation: suggested-user safety fixtures are isolated from unrelated ranked users, still using the real database predicate and retaining age/privacy/block assertions. No production filter was weakened.

## Final local evidence

Node 20.19.6, independent dependencies, disposable PostgreSQL on port 55439, production dotenv loading disabled for database tests.

| Check                                                | Result                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Full client                                          | 232 suites / 1,694 tests passed                                                                    |
| Full server                                          | 345 suites / 3,258 tests passed                                                                    |
| Client and server TypeScript                         | Both passed                                                                                        |
| Node release/routing/telemetry/inventory regressions | 17 passed                                                                                          |
| Matrix inventory                                     | No drift or evidence-reference errors; 2,678 unclassified diagnostic surfaces                      |
| Full matrix command run                              | 17/18 gates passed; strict readiness blocked by installed ad-purchase journey evidence             |
| Local release verifier                               | Passed with its own local API and disposable DB                                                    |
| Build readiness                                      | Passed with four reported local/signing warnings                                                   |
| Public runtime health/email configuration            | Passed; not a delivery or protected-provider integration test                                      |
| Web export                                           | Passed on patched dependencies                                                                     |
| Browser guest smoke                                  | Feed, Discover, Profile → Sign In, Create → Login passed; final fresh-origin flow logged no errors |

Evidence logs are local temporary artifacts: `/private/tmp/varsityhub-release-client-final3.log`, `/private/tmp/varsityhub-release-server-final4.log`, `/private/tmp/varsityhub-release-node-final.log`, `/private/tmp/varsityhub-release-matrix-inventory-final2.log`, `/private/tmp/varsityhub-release-local-isolated.log`, `/private/tmp/varsityhub-release-build-final.log`, `/private/tmp/varsityhub-release-runtime.log`, and `/private/tmp/varsityhub-release-web-permission-fixed.log`. Review the test counts rather than assuming these temporary files will exist on another machine.

The web preview used the existing production API for read-only guest flows; it did not have every production provider key. No real user content or purchase was created. Jest reports teardown/open-handle warnings; no measured device speedup or claim that every feature works follows from these test passes.

## Release blockers — do not silently waive

1. `node-forge` 1.4.0 scanner finding `SNYK-JS-NODEFORGE-19635204`: no fixed registry successor at inspection. The owner explicitly chose **wait for an official package fix**. No backport, temporary exception, or scanner bypass is authorized or applied.
2. Physical installed-app evidence for 1.0.5 and 1.0.6: media selection/upload/playback/cancellation, foreground/background behavior and required payment journeys. Source compatibility and completed EAS builds do not establish device acceptance or store availability.
3. Canonical launch gates: candidate staging, provider delivery/payment evidence, monitoring/alerts, restore/load/rollback and required owner signoffs. Unknown is not PASS.
4. Fresh remote CI must pass on the pushed candidate. Main, Railway, Vercel and EAS production delivery remain separate controlled actions.

## GitHub follow-up

Application source `a3f60014ef240171b9ba2cd3d5a9fd05c3ed75e1` passed remote client/server tests, server invariants, both type checks, lint, formatting, route/cache guards, npm dependency audit, public API health, web export and gitleaks. [Source CI](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/35066177070) and [secret scan](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/35066177203) completed. The separate [Snyk dependency job](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/35066177094) still fails; the green aggregate named “All Checks Passed” does not override that failure. Any subsequent commit needs its own remote checks before release.

Two CI findings received narrow corrections: Prettier formatting in the inherited event serializer; and a historical false positive on the isolation test's fabricated signing key. The test now generates its key per run. `.gitleaksignore` marks only the exact original commit/file/rule/line fingerprint, with rationale; it does not exempt a real credential, broad path or scanner rule. The isolation regression and independent review passed; the completed source CI above confirms formatting and gitleaks acceptance.

Device inventory currently shows no attached Android and two unavailable iPhones. No installed-device checks are being reported as passed.

Follow-up `b9778322` passed remote gitleaks and formatting. The first root SAST scan reported 49 unique findings: 41 matched existing rule/path reviews, seven were the previously undocumented shared-link sinks repaired above, and one was consent's development CSRF fallback (normal production startup requires a valid JWT secret before serving). Do not describe all advisory findings as newly verified clean or disable their reporting. The node-forge dependency finding remains a real release blocker with no new exception added.

## Delivery order

Isolated staging infrastructure is now created and verified; the API itself is **not deployed** pending separate test-provider configuration. See the [staging handoff](2026-09-16-isolated-staging-handoff.md) for exact resources, observed evidence and remaining work. This does not close the staging, provider or production gates.

Clean reviewed GitHub candidate → CI and external acceptance gates → API dual-reader deployment with legacy writing → readiness and old-replica drain → optional v2 writer activation → production web → separate compatible OTA publications for 1.0.5 and 1.0.6 → verify returned runtime/platform/update IDs and the 15-minute observation window.

No native compressor interruption repair is part of this candidate. If immediate native interruption is required, implement and test it in new native builds with a binary capability strategy; do not claim an OTA can retrofit native code.
