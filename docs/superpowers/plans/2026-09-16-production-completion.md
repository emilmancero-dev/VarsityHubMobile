# VarsityHub Production Completion Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` inline, with bounded independent planning/review where required by AGENTS.md. Update checkboxes only from observed evidence. The user explicitly requested this plan followed by continued execution through a clean GitHub push and production delivery.

**Goal:** Finish the surgical repairs, verify one reproducible release candidate, push it to the maintained GitHub repository, and deliver compatible production updates to runtime **1.0.5** and **1.0.6**, plus the web app.

**Architecture:** Preserve the existing QueryClient, modular API, server-owned safety/payment/media rules, serialized media pipeline and durable retries. Fix demonstrated causes at their owning boundary. Native fixes require a native build; older installed binaries receive only compatible JavaScript and must never invoke a newly required native API blindly.

**Tech Stack:** Expo/React Native, TypeScript/Jest, Android Kotlin/iOS Swift, EAS Update/Build, Express/Prisma/PostgreSQL/Redis, Railway, existing web deployment tooling.

**Spec:** `docs/superpowers/specs/2026-09-15-production-recovery-canonical-rules-design.md`; approved repair scope in `docs/superpowers/plans/2026-09-15-phased-performance-repairs.md`; current video finding in `docs/release/2026-09-16-phase5-cancellation-investigation.md`; latest user instruction adds clean GitHub delivery and both requested runtime lines.

## Global constraints

- Work in `/Users/varsityhub/Code/VarsityHubMobile-performance-repairs`, branch `codex/phased-performance-repairs`. Preserve the original checkout's media-picker edits and all other worktrees.
- The local baseline is `7ba08b49`, plus this task's uncommitted cancellation draft. Do not publish that draft as-is.
- No hook bypasses, force pushes, ignored failing safety checks, invented measurements, or credentials in logs.
- Do not edit the original checkout's dependencies. On September 16 the two dependency symlinks were moved intact to `/private/tmp/varsityhub-release-deps.Thfuva`, then independent dependencies were installed in this worktree for patched-lockfile verification. Native experiments must remain isolated.
- Preserve permissions, age/block/private-content rules, approved payment flows, upload limits and server asset verification. Tests use a disposable database with production environment loading disabled.
- Scope excludes redesign, broad cleanup, unrelated feature work, runtime/library upgrades without a demonstrated need, production test-account writes, paid purchase experiments, and secrets rotation.
- Native capability differences must be detected from the binary, not inferred from an OTA runtime string. Runtime override is allowed only after compatibility verification.
- Publishing an update is not proof that a device installed it. Record update/build IDs, runtime/platform/channel and delivery checks separately from device acceptance evidence.
- Required external evidence stays UNKNOWN until observed. A blocker pauses only the affected release action while safe in-scope repairs/checks continue. Do not repeat a request for authority already supplied.

## Phase 1 — Establish source, runtime and rollout truth

**Files:** `app.config.js`, `app.json`, `eas.json`, `railway.toml`, `.github/workflows/publish-ota-update.yml`, `.github/workflows/deploy-web.yml`, `scripts/deploy-web.sh`, existing release docs.

- [x] Verify linked worktree and preserve original dirty checkout.
- [x] Identify maintained remote: `fork` is `emilmancero-dev/VarsityHubMobile`; production Railway API now uses this repository. `origin` is the older `xsantcastx/VarsityHubMobile` repository and must not receive a blind push.
- [x] Read production EAS channel/update history and finished native build metadata for both requested runtimes. Previous groups: 1.0.5 `c8d98c2f-a68e-469a-b0d8-c53eb94672f8`; 1.0.6 `f572d965-4f5d-44ce-8fbc-8152451bdd63`. Recheck before delivery.
- [x] Compare candidate ancestry against remote main, including the earlier 13 commits preceding the repair batch. Classify native differences against actual build commits. Independent review found a linked-post double count, reproduced and repaired in Phase 3; physical binary acceptance remains open.
- [x] Read exact CI failure logs: Redis runner prerequisite, stale story-error test, matrix inventory drift, real dependency findings, missing OTA token. Earlier live-window/picker/format failures are already repaired.
- [x] Confirm current web host/source, API deployment and staging state. September 16 live HTTP headers confirm `www.varsityhub.app` is Vercel despite Railway custom-domain registrations; apex redirects there. API health is OK. Latest API deployment `7c5a9d55-f4ea-473b-acb6-c34bf01af603`; testing deployment is failed. Candidate staging remains required.
- [x] Resolve automatic deployment ordering before pushing main: web/OTA now require explicit dispatch; cursor writing defaults to legacy format until all API replicas support both formats. Existing API `overlapSeconds=30` still requires verifying the first deployment drained before activating v2 writers.

Read-only commands:

```sh
git status --short
git ls-remote fork refs/heads/main
git log --oneline fork/main..HEAD
eas update:list --branch production --limit 25 --json --non-interactive
eas build:list --status finished --limit 25 --json --non-interactive
gh run list --repo emilmancero-dev/VarsityHubMobile --limit 20
railway status --json
```

## Phase 2 — Repair video cancellation at its actual boundary

**Files:** `utils/compressVideo.ts`, `utils/__tests__/videoPreparationCancellation.test.ts`, `utils/__tests__/webVideoPreparation.test.ts`, `apiclient/videoUpload.ts`, `apiclient/__tests__/videoUpload.test.ts`, `app/(tabs)/create-post.tsx`, `app/__tests__/create-post-image-preparation.test.tsx`; a versioned compressor patch and native test harness only if needed after source review.

**Interface:** `prepareVideoForUpload(uri, { signal?: AbortSignal, onCompressProgress? })`; cancellation rejects with `AbortError`, never uploads or publishes a cancelled result, and never overlaps native encoder ownership.

- [x] Reproduce seven JavaScript gaps before their fixes (five preparation cases and two consumer signal paths); retain regressions.
- [x] Add an Android regression with a native cancellation double that never settles. Legacy Android never invokes it or releases the queue while encoding.
- [x] Use safe compatibility on existing binaries: queued cancellation skips encoding; active legacy Android waits for normal settlement, with no publication/progress. Composer explicitly acknowledges the wait.
- [ ] For true native interruption, test pre-start, active encode and audio/finalization cancellation. Ensure all owned codec/surface/extractor/muxer resources are closed before exactly-once promise settlement; use a binary capability if calling the repaired API from an OTA-compatible bundle.
- [x] Verify iOS cancellation settlement from native source and targeted tests; physical-device acceptance remains separate and open. Existing native temporary-file cleanup caveat is recorded in the Phase 5 investigation.
- [x] Rerun preparation, cached retry, media limits, upload recovery, cancellation, composer and web tests. Independent review approved commit `ab861fc4`. No native interruption patch is included; installed-device acceptance remains open.

Behavioral expectations:

```ts
expect(cancelledResult).toMatchObject({ name: 'AbortError' });
expect(nativeEncodesWhileFirstStillRunning).toBe(1);
expect(cancelledQueuedSourceWasOpened).toBe(false);
expect(cancelledResultWasPublished).toBe(false);
expect(await nextPreparation).toMatchObject({ wasCompressed: true });
```

Run focused tests with Node 20.19.6:

```sh
node node_modules/jest/bin/jest.js --watchman=false --runInBand --runTestsByPath utils/__tests__/videoPreparationCancellation.test.ts utils/__tests__/compressVideo.test.ts utils/__tests__/webVideoPreparation.test.ts utils/__tests__/resumableUpload.test.ts apiclient/__tests__/videoUpload.test.ts app/__tests__/create-post-image-preparation.test.tsx
```

## Phase 3 — Close release-blocking continuity and CI defects

**Files:** `server/src/lib/postPageCursor.ts`, `server/src/routes/posts.ts`, `server/src/routes/feed.ts`, related pagination/privacy tests; exact failing workflow/script/test files identified by Phase 1. Existing matrix sources remain authoritative.

- [x] Validate old/new cursor rollout and rollback in source/tests. Both readers are permanent; legacy writing remains the default. Actual deployment/drain/activation remains Phase 5 work.
- [ ] For each current failing gate: capture expected/actual, write or identify a failing behavior regression, patch only the root cause, rerun that test and its neighboring safety paths, and commit the independent repair.
- [x] Run full client tests, both typechecks, conflict/secret/navigation/error-envelope checks, and full server/matrix verification on the isolated database. Strict matrix was executed and remains NO-GO for missing installed ad-purchase evidence; execution does not mean every gate passed.
- [x] Run `release:verify:local` and `release:verify:build` using the established workflow. Both passed; the build check reported four non-blocking local/signing warnings. The public runtime health and email configuration gate passed too. These do not prove provider delivery or physical-device acceptance.
- [ ] Run a production-configured web export and browser smoke against the candidate. Check authentication entry, Feed/Discover, pagination, error/retry and media paths without mutating real user data.
- [ ] Gather physical-device cancellation/playback/upload and installed purchase evidence required by the matrix. Missing access remains a release blocker where the canonical gate requires it; no fake passes.

```sh
npm run check:conflicts
npm run audit:navigation:fail
npm run verify:error-envelope
npm run verify:secrets
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit --project server/tsconfig.json
node node_modules/jest/bin/jest.js --watchman=false --runInBand
npm run audit:matrix
npm run audit:matrix:strict
npm run release:verify:local
npm run release:verify:build
```

Before executing any database-backed script, inspect its environment loading and assert it targets only the disposable local database. Keep production verification read-only unless a specific deployment action is being performed.

## Phase 4 — Clean, reviewed GitHub candidate

**Files:** release evidence report, scoped production/test changes, workflow ordering fixes if required. No blanket staging of unrelated files.

- [x] Review final diff and all earlier candidate commits for intended scope; resolve critical/important code findings with reproducing tests. External readiness/security decisions remain separately listed blockers.
- [x] Commit explicit paths with hooks enabled. Initial candidate `27be6cb1` had an empty tree and passing OTA clean-tree guard; follow-up commits must repeat both checks.
- [x] Push the clean repair branch to the maintained GitHub repository and run CI on that exact SHA. [Draft PR #25](https://github.com/emilmancero-dev/VarsityHubMobile/pull/25) is open; CI follow-up fixes remain subject to fresh remote verification. This is not production publication.
- [ ] Before advancing main, re-read remote main and active deployments, avoid force push, and verify automated production jobs cannot outrun the backend compatibility rollout.
- [ ] Advance the production source only after candidate checks and canonical required evidence pass. Preserve the original checkout and its uncommitted work.

## Phase 5 — Ordered production delivery

**API:** Record old deployment/commit and rollback path. Release compatibility support first where needed, verify health/read-only runtime and privacy tests, then activate new writers. Stop rollout on health failure, authorization leakage, cursor-loss reproduction, or a sustained error-rate increase above the recorded baseline.

**Web:** Use the verified current web hosting route and production public configuration. Build from the clean candidate, capture the prior deployment, publish, verify real domain navigation/assets/API requests and rollback if smoke fails. Do not run an obsolete Vercel script if the current live host changed.

**Mobile 1.0.5 and 1.0.6:** Resolve production channel and binary compatibility first. Publish the compatible JavaScript bundle separately for each supported runtime using the existing explicit legacy-runtime acknowledgement where required. Upload source maps. Verify returned group IDs contain the intended runtime and platforms. Native compressor changes require an EAS build and compatible runtime/capability strategy; a finished build is not an installed/store-available release.

- [ ] API candidate healthy and compatible; rollback target recorded.
- [ ] Web candidate published and browser smoke passed; rollback target recorded.
- [ ] Runtime 1.0.5 production update/build delivery verified for its actual supported platforms.
- [ ] Runtime 1.0.6 production update/build delivery verified for its actual supported platforms.
- [ ] Any required native build completed and distributed through the authorized production path; external store review or device installation remains explicit until observed.

## Phase 6 — Verify and hand off

- [ ] Observe post-deploy errors/latency and required read-only user flows for the release checklist's 15-minute window; use bounded waits and keep the user informed.
- [ ] Confirm GitHub SHA, clean tree, API deployment, web deployment and both runtime update/build IDs agree with release notes.
- [ ] Write final summary of root causes, changes, tests, platform behavior, rollout/rollback and anything still unverified. Do not call the full app flawless based on this repair batch.
- [ ] Mark the persistent production goal complete only after the requested deliveries and required gates are actually satisfied. If externally blocked, record exact missing evidence/action and continue every unaffected safe task.

## Plan self-review

The plan covers source isolation, Android cancellation root cause, legacy runtime compatibility, web verification, CI/matrix gates, deployment ordering, clean GitHub delivery, both requested runtime lines, and post-deployment verification. Broader feature gaps/product decisions from earlier audits remain tracked rather than silently included in a release or declared closed.

## Current implementation checkpoint — September 16

- Latest application source `a3f60014` passed remote client/server CI, both typechecks, formatting and gitleaks; Snyk dependency scanning still fails. The owner explicitly chose to wait for an official node-forge fix: no backport, scanner exception or release bypass is authorized.
- Newly authorized isolated Railway staging infrastructure is running: fresh PostgreSQL and Redis, plus an undeployed API service, all confined to testing. Original testing services and production remain unchanged. Database TLS/temporary read-write/empty-schema and Redis authentication/empty-keyspace checks passed. Application startup, migrations, provider integration, devices and production delivery remain open; see the [staging handoff](../../release/2026-09-16-isolated-staging-handoff.md).

- Final local candidate verification: full client **232 suites / 1,694 tests**, full server **345 suites / 3,258 tests**, both typechecks, and **17 Node script regressions** passed. Jest teardown warnings remain and are not performance measurements. See the [candidate summary](../../release/2026-09-16-production-candidate-summary.md) for evidence and limits.
- Cursor rollout now defaults to legacy response markers. Deploy with `POST_PAGE_CURSOR_V2_WRITE_ENABLED` absent/false; confirm original replicas drained after readiness; then redeploy the SAME tested candidate with this nonsecret flag exactly `true`. Both readers remain enabled. Once p2/t2 has been issued, rollback only to the dual-reader candidate (flag false is safe), never the original server. The original server's existing boundary-skip defect may remain during stage-one overlap.
- Independent review approved cursor rollout; all 30 pagination cases passed in the full server run, including both sparse-boundary regressions.
- Web/OTA workflows now require explicit dispatch. The shared OTA wrapper enforces a clean tree, pins runtime after loading EAS production variables, supplies the required noninteractive SHA/runtime message, and uploads maps once. Four workflow regressions pass; independent review approved. Production publishing has NOT run.
- Security lockfile updates are limited to compression 1.8.2, multer 2.4.0, proxy-addr 2.0.8, moment 2.31.0 and undici 6.28.1 where present. `node-forge` 1.4.0 has no published fixed successor as of this check; the owner chose to wait for the official package fix. No security exception, backport or ignore was added.
- Matrix inventory: zero drift, zero evidence-reference errors; **2,678 diagnostic surfaces remain unclassified** after removing two entries belonging to the deleted duplicate root. This does not mean 2,678 bugs or verified features. Workflow/device evidence still decides release readiness.
- Web export warning gate passed on independently installed patched dependencies. Production configuration/browser smoke remains open.
- Device access requested without pausing safe local work. Canonical physical-device, staging, provider, restore/load and sign-off gates are not waived by automated tests.
- Full isolated matrix execution passed 17 of 18 command gates. Strict workflow readiness remains blocked only on `FLOW-AD-PURCHASE` (installed-app journey evidence). No readiness status was fabricated or relaxed.
- Release verifier isolation repair is committed in `f4a3822b`: it now owns its local API and refuses an occupied port. One unused synthetic account created by the prior verifier in the original local development database was precisely identified and removed; no production account was touched.
- Browser smoke confirmed public Feed and Discover and both Profile → Sign In and Create → Login entry paths against the existing production API. Chrome/theme hydration and duplicate-root resolution are repaired with regressions. Guest composer location prompts were separately reproduced and restricted to focused, authenticated, verified composers; the previously blocked Login path passes in the rebuilt export. No browser errors were observed in the final fresh-origin guest flow. This is not signed-in/provider/media/device acceptance or a fully configured production-host deployment.
- Analytics timestamp corruption is reproduced with the actual SDK and repaired without relaxing privacy scrubbing. The earlier old-origin missing-event HTTP 400 was not independently attributed to timestamp corruption; no claim is made that all historic queued telemetry is repaired.
- First GitHub run identified one formatting difference in an inherited event serializer and a fabricated test-key false positive. The serializer is formatted; the isolation test now generates a random key. Only the exact original commit/file/rule/line fingerprint is marked in `.gitleaksignore`; no real credential, file or rule is broadly excluded. Independent review approved both changes and the isolation regression passed. Remote source CI on `a3f60014` confirmed acceptance.
- Physical-device inventory rechecked: no Android device attached; both known iPhones unavailable. This cannot substitute for installed-build acceptance.
- Follow-up security triage reproduced forwarded scheme/host poisoning in inherited share landing links. All seven paths now use validated configured public origins; seven new regressions and the full backend suite pass. Existing production `APP_BASE_URL=https://varsityhub.app` was verified read-only; no provider settings changed. The Snyk dependency blocker remains open.
