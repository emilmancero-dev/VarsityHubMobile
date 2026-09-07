# Recovery and native investigation follow-up — September 6, 2026

## Reproduced and fixed

1. The error screen called `Updates.reloadAsync()` directly, bypassing the coordinator used by the root update paths. A test executing the real error screen during an in-flight update observed two native reload calls. All application callers now use the same module-level coordinator; the test observes one. This removes a proven overlapping-reload path. It does not establish the cause or resolution of Sentry 49.
2. The legacy signed-ad-receipt handler accepted revoked transactions and malformed quantities. Six regression cases reached fulfillment before the fix and now return 400 with structured `apple_ad_receipt_boundary` telemetry. Legacy and intent-bound receipts share one runtime schema applied after Apple signature verification. Distinct valid transactions and idempotent duplicate-delivery controls continue to pass. Revocation semantics follow [Apple's transaction payload](https://apple.github.io/app-store-server-library-node/interfaces/JWSTransactionDecodedPayload.html).
3. Apple orphan reconciliation selected all pending payment rails before taking its 50-row batch. An actual PostgreSQL test with 55 older unpaid Stripe checkouts left a later Apple purchase PENDING. Rail filtering now precedes batching, and that purchase completes without modifying the Stripe payments.
4. Apple rows missing recovery evidence repeatedly consumed the oldest batch. They now move conditionally to NEEDS_REVIEW with a recorded reason, preserving their evidence. The state transition checks the observed update timestamp so it cannot overwrite a concurrent receipt update or completion. The regression failed before this change and now lets the next valid purchase complete.
5. Repeated finalization failures could also monopolize recovery batches. The job rotates retryable attempts by update time while preserving PENDING, and reports both the original failure and any failure to record the attempt. A PostgreSQL trigger forces a 50-row account-write failure; a later healthy account's purchase still completes. Removing attempt rotation makes that regression fail with the healthy purchase remaining PENDING.

No migration or native dependency change is required for these fixes. Rollback requires reverting client/server source; do not delete purchase evidence or reset completed transactions.

## Verification

- Full local release workflow passed: both TypeScript projects, lint, guardrails, navigation, 166 client regression tests, 135 server regression tests, Expo checks and approval checks. Reload and legacy receipt regressions are included in the canonical release commands.
- All 27 actual-PostgreSQL purchase recovery/finalization/inventory tests pass, including the expanded batch tests. Fixtures are cleaned after each test so globally scheduled jobs cannot consume another test's pending purchases.
- Receipt boundary and real certificate-forgery suites: 11 tests pass. The cryptographic boundary is mocked only for controlled receipt payload tests; the separate signature test uses real certificate verification.
- Build-readiness checks pass with four warnings and no blocking errors. These release commands did not perform a native archive or physical-device test; subsequent simulator work is recorded below.
- Failure logs: `/tmp/vh-native-reload-before.log`, `/tmp/vh-legacy-boundary-before.log`, `/tmp/vh-apple-starvation-before.log`, `/tmp/vh-apple-evidence-before.log`, `/tmp/vh-apple-rotation-before.log`. Passing logs: `/tmp/vh-open-gates-local.log`, `/tmp/vh-open-gates-db-complete.log`, `/tmp/vh-open-gates-receipt-final.log`.

## Current evidence and external dependencies

- A read-only production aggregate found three AD_PURCHASE ledger rows, all COMPLETED with source apple_iap. No PENDING/NEEDS_REVIEW server ledger rows were observed. This cannot establish the state of receipts that never reached the server or were lost in an older client.
- Configured Apple bundle/client/team identifiers and the shared receipt secret do not provide the App Store Server API issuer/key/private-key configuration needed to query missing signed transactions. No new key was generated or secret printed. Full recovery of unreported purchases requires the affected transaction/receipt evidence and an authorized lookup path; ownership must not be guessed.
- Existing ESPN provider probes for `soccer/usa.mls.next.pro`, `soccer/usa.mls.next`, `baseball/milb` and `baseball/aaa` returned HTTP 400 rather than schedules. This is not an exhaustive provider search, but it disproves enabling these exact paths as a working connection. MiLB, MLS NEXT and MLS NEXT Pro remain unconnected. Authorized provider details are still needed; [MLB's published data-use terms](https://gdx.mlb.com/components/copyright.txt) do not grant commercial bulk use by default.
- Installed RN 0.81.5 legacy interop reads a child's native contentView at insertion, and recycle clears that view. Maps 1.20.1 inserts the supplied child into an array. Installed ExpoModulesCore 3.0.30 clears its shared-object registry asynchronously when AppContext unpins its runtime. These are concrete lifetime paths to trace; their presence alone does not prove which ordering caused a production crash.
- The inspected maps 1.29.0 candidate has Fabric marker views, but recycling still sets the underlying marker to nil and the Apple map insertion still expects a nonnil child. No upgrade was installed merely on the assumption that a new version fixes the incident.
- Physical-device verification remains unavailable. The user said a simulator was not needed; this is not treated as a prohibition on automated native tests under the later instruction to do everything. Local simulator investigation continues separately from physical-device crash resolution.

## Publication and independent restore verification

- Tested application source: `d0ebb4844eea56803315fcd9d49f344085be2914`.
- Railway production API deployment `ca9c4a3d-5236-49d4-aa19-e73471313ce3` reached SUCCESS. The production runtime release workflow exited 0.
- Guarded `npm run update:production` exited 0, including Sentry source-map upload. EAS independently reports both platforms on branch production, runtime 1.0.5, with the source commit above: [update group c5d823cd](https://expo.dev/accounts/varsity-hub/projects/varsityhub/updates/c5d823cd-7400-4fc5-bd29-63b1edf34deb).
- iOS update: `01a078dd-5488-73a5-a118-53375b7c7efd`; Android: `01a078dd-5488-7bce-bd8d-713798429ad0`.
- [Independent scheduled-workflow restore run 34064154955](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34064154955) succeeded against this source: 63 tables, 4,341 rows, content parity, migration deployment, application constraints, purchase recovery and cleanup all passed. Its workflow source pin is deployed through workflow-only commit `d4460164` on the fork's main branch.
- The local actual-backup drill also passed. Its isolated PostgreSQL cluster and restored data were removed after verification.
- A fresh Sentry lookup still reports 3T at 12 events (last 06:41:24 UTC), 49 at 2 (last 15:40:49 UTC), and 3M's latest-event lookup as 404. App debug symbols are available; React/Hermes artifacts still have symbol tables/unwind data without full DWARF debug information. These observations are not a seven-day crash-free result.

## Additional provider research

The official [MLS NEXT schedule](https://www.mlssoccer.com/mlsnext/schedule/) embeds Modular11 (`https://www.modular11.com/schedule?year=21`). Its public schedule uses an HTML endpoint, not a documented integration contract. A bounded read-only request returned "No data available"; that does not establish offseason, coverage or a working importer. No production catalog was activated from that response. MLS's [published terms, section 5.2](https://www.mlssoccer.com/legal/terms-of-service) restrict automated collection for commercial purposes. An authorized provider/API or bulk export remains necessary before shipping this source.

The existing secondary provider, TheSportsDB, also lists [MLS NEXT Pro (5279)](https://www.thesportsdb.com/league/5279-MLS-Next-Pro) and [International League (5085)](https://www.thesportsdb.com/league/5085-international-league). Read-only development-key probes returned one upcoming event each. The International League event had no venue; both season responses were limited to five records and had none in the tested horizon. Production has no dedicated `PRO_SCHEDULE_TSDB_KEY`. The provider's [terms](https://www.thesportsdb.com/docs_terms_of_use.php) require a paid subscription for App Store apps. These are concrete candidate sources, not complete coverage or live connections; MLS NEXT Pro is not youth MLS NEXT. The existing WWE adapter also defaults to the development key, so its production provider configuration needs the same review.

## Local native execution

Xcode 26.3 successfully built the current source with the installed native dependencies for iPhone 17 Pro Simulator / iOS 26.2. No EAS build credits were used, no distribution archive was created, and no native binary was shipped.

An isolated harness uses the real `EventMap` and installed Apple Maps path with 240 generated fixtures. It cycles empty/loading, full markers, a filtered subset, four shared-coordinate clusters, map unmount, and remount. Unmount/remount is a navigation stand-in; this is not end-to-end detail routing. It requests no GPS permission and accesses no production accounts or receipts. Source: `scripts/native-map-lifetime-harness.tsx` (not a production entrypoint).

Observed evidence:

- LLDB captured `AIRMap insertReactSubview:atIndex:` called by `RCTLegacyViewManagerInteropComponentView mountChildComponentView:index:`. The observed child was a nonnil AIRMapMarker at index 60.
- The conditional breakpoint evaluator timed out on a valid child. The debugger was detached; this is an instrumentation failure, not reproduction of 3T.
- The harness reached step 600 with a visible Apple map. This means 600 React state updates, not proof that every intermediate update had a separate native commit or that memory returned to baseline.
- Maestro live hierarchy polling failed with HTTP 500 during rapid mutation. Its full stress flow is not recorded as passing.
- A subsequent run reached background state at step 180. Resuming the same PID with simctl completed to step 600; a separate Maestro assertion for COMPLETE with a positive background count passed. The requested five-cycle Maestro loop did not pass, so only the observed background/foreground cycle is claimed.
- Neither 3T nor 49 was reproduced by this sequence. No candidate native fix was selected from a non-reproduction. Physical-device crash resolution and runtime shared-object lifetime proof remain open.

For repetition, use an isolated checkout with dependencies installed, set only that checkout's `package.json` main to `scripts/native-map-lifetime-harness.tsx`, and start Expo from that checkout's real filesystem path using the development client on port 8082. Install the locally built simulator app and open `varsityhubmobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082`. Tap Start stress, wait for completion, and assert the counter after mutation settles. Do not point the production package entrypoint at this harness. Preserve native crash logs and record device/runtime, source commit, number of runs and any automation failures separately.

## Owner provider restriction and final harness check

The owner explicitly rejected TheSportsDB and restricted provider choices to ESPN or Yahoo. TheSportsDB candidates are therefore ruled out. `PRO_SCHEDULE_PROVIDER=espn` previously resolved to `composite(espn+thesportsdb:wwe)`; a new regression demonstrated that mismatch. It now resolves only to ESPN. WWE's removed provider metadata is cleared by an additive data migration, preserving all existing events and retaining event-backed catalog visibility. The old adapter file is not imported by the live resolver. No Yahoo connection is claimed without a verified contract.

The read-only ESPN core API league indexes returned 12 baseball leagues and 218 soccer competitions, with complete one-page results. Neither index includes affiliated MiLB or MLS NEXT / MLS NEXT Pro. The old ESPN minor-league web result contains obsolete teams and is not accepted as a current schedule source. Yahoo search returned news articles; direct schedule/developer-page reads were rate-limited. Neither articles nor guessed endpoint paths establish an importer. Missing league coverage remains explicit under the owner's allowed-provider restriction.

The final checked-in harness version was executed again, reached step 600, and passed a separate Maestro completion assertion after the rapid updates settled. The earlier positive-background-count assertion also passed. Native maps libraries were not upgraded or patched. Simulator results do not close production crashes or substitute for physical-device evidence.

## Final deployed provider configuration

- Final server source: `f3a5f98e0911ac1c177f8a7979bd44e52e5f17c6`; Railway deployment `a9cce1e5-e060-4f6e-b9cd-9e54c8134b89` reached SUCCESS. The full local release workflow and production runtime workflow exited 0. The canonical server regression count is now 136.
- Live `/events/sports-leagues?q=WWE` changed from provider `thesportsdb` / `ACTIVE_SYNCING` to null provider / `SEEDED_EVENTS`. All 19 current events remain visible.
- Backup refreshed to 63 tables / 4,370 rows / 162 exactly matching migration-history records. The local actual restore and [independent run 34068927431](https://github.com/emilmancero-dev/VarsityHubMobile/actions/runs/34068927431) passed content comparison, migration deployment, application constraints, purchase recovery and cleanup. Daily workflow source is pinned to this application commit by workflow commit `c0cb6cb3`.
- The isolated local PostgreSQL cluster and restored customer data were removed. The simulator test app was stopped; the temporary harness checkout and its Metro servers were removed/stopped.
- Client production OTA remains the verified `d0ebb484` update group listed above. The later change affects server provider selection and adds a non-production harness/documentation; no additional client bundle or native distribution is needed for that change.
- PR #281 was verified OPEN and MERGEABLE at source `f3a5f98e`; the upstream account still cannot merge. Server and OTA publication were performed independently of that open PR.
