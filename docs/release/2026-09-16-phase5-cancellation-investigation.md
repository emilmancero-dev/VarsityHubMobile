# Phase 5 — compatible cancellation repair and native follow-up

Status: **OTA-compatible deferral implemented; production gates remain open**. Work is in the isolated `codex/phased-performance-repairs` worktree, based on `7ba08b49`. Nothing in this repair batch has been pushed, deployed or installed on a device. The original checkout and linked dependencies remain untouched.

## Confirmed application gap

The composer and shared video uploader have an AbortSignal, but neither passed it to video preparation. Preparation also had no signal handling. A cancelled job could still encode, continue reporting progress, and consume time before the next queued preparation.

Five new tests failed against the original preparation code: already-cancelled work, cancelling an active native job, cancelling queued work, cancellation during metadata lookup, and native success racing cancellation. Two more regressions failed at the composer/uploader boundary because preparation received no signal.

## Compatible JavaScript changes

- Thread the existing signal from composer and shared uploader through the existing preparation pipeline.
- Skip aborted queued preparations, check cancellation after asynchronous preparation stages, and abort browser source reads.
- On iOS, cancel only the native job identified by the compressor's cancellation ID. On existing Android binaries, never invoke the unsafe native cancel method: finish the active encode, discard its cancelled result, then release the queue. Suppress late progress on both platforms.
- Preserve serialization until native settlement, prepared-file retry behavior, size/duration/quality limits, and server verification.
- Additional checks cover delayed native registration, abort before native invocation, listener cleanup and a throwing cancel bridge.
- Show a disabled "Cancelling upload" state while waiting for settlement. Never claim the encoder has already stopped.
- If cancellation arrives during the durable copy or output stat, finish indexing the completed copy before rejecting so a retry does not re-encode it.
- If the copy cannot be indexed (missing source timestamp, cache write failure or output-stat failure), cancellation removes only the newly created owned copy. Reused/original files are preserved. Four additional regressions cover these branches.

This is safe deferred cancellation on Android, not immediate native interruption. It cannot recover an unrelated native encode that independently hangs. A rebuilt native compressor with verified cleanup/settlement is a separate pending improvement; no such patch is included in this OTA candidate.

## Native root cause and compatibility decision

Installed dependency: `react-native-compressor` **1.16.0**. Independent Astra review identified a source-level cancellation race, which was confirmed by reading the installed native code:

- Android `VideoCompressorClass.kt:44–46` cancels its coroutine and clears a shared running flag.
- Its main-thread coroutine (`:60–84`) delivers success/failure only after the background compression call returns.
- `compressor/Compressor.kt:271–281` signals cancellation only inside the video encoding loop. The later audio/finalization path (`:392–405`) does not provide that callback.
- Cancelling before the coroutine starts, or during later finalization, can skip all callbacks that resolve/reject the JavaScript promise. `Utils.kt:78–86` also removes the native job reference after cancelling it.

The superseded draft invoked that unsafe cancellation API and could therefore poison the queue. The current code avoids invoking it on Android. A JavaScript timeout that simply releases the queue is not a safe fix: native work may still be running, and Android uses shared compressor state.

This race is **source-derived, not reproduced on an Android device**. The new Android regression uses a cancel double that does not settle, asserts it is never invoked, and confirms the next encode waits for normal settlement. This does not establish physical-device latency or native codec correctness.

Future native work must settle exactly once after resource cleanup, including pre-start, active-encode and finalization cases, and advertise capability from the binary before JavaScript uses the repaired path. A native dependency patch requires a fresh Android binary; OTA alone cannot repair installed native code. iOS source review found explicit reader/writer cancellation followed by completion/reset; this is source evidence, not device evidence. Its pre-existing temporary-file deletion uses a URL string as a filesystem path, so complete native temporary-file cleanup is not claimed.

## Verification performed

- Baseline: 51 tests in four focused client suites passed.
- Draft: 88 tests in nine media/preparation/upload/playback suites passed, including the seven red-to-green regressions and five additional edge cases.
- Both full client and server TypeScript checks passed.
- Explicit lint: zero errors, three existing `any` warnings in the uploader; four test paths were excluded by repository lint configuration (not claimed linted).
- Independent re-review: Android queue-poisoning issue resolved by deferral; one durable-copy indexing issue identified and repaired with two red-to-green regressions.
- Current full client run: **229 suites / 1,680 tests passed**; both full TypeScript checks passed. Evidence: `/private/tmp/varsityhub-release-client.json`. These results precede any subsequent dependency remediation and must be rerun afterward.
- Fresh dependency run also passed **229 / 1,680** before the last four cleanup regressions were added. The final bounded cleanup review independently passed **16 cancellation tests**; related preparation/web run passed **51 tests**. Commit `ab861fc4` contains the reviewed cancellation repair.
- No backend production runtime test, full release matrix, release build or physical-device performance acceptance is claimed. Previous Phase 4 evidence remains separate.
- Apple device inventory showed only the Mac online, two iPhones offline and an iPhone simulator. A simulator is not physical-device performance evidence. Android physical-device availability is unverified.

No speed percentage, complete cancellation guarantee, or Phase 5 completion is claimed. Video playback tuning, provider processing measurements and final continuity/release verification remain open.
