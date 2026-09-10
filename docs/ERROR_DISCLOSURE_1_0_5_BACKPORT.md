# Error-disclosure OTA backport for runtime 1.0.5

Base: `60a7f2065ccd5ec79854c09198e615cc76ffc77d`, the source commit of production update group `5fcb4ee6-278f-4b47-9eb7-ff8fa5d14aa3`.

Backports the client public-message allowlist, safe error output callsites, and final telemetry filters from `dcb2281a`. The exact PHPhotosErrorDomain 3164 message is covered by regression tests and cannot be echoed by the shared public-error helper. This fixes disclosure; it does not claim to repair every native Photos acquisition failure.

The app version/runtime, dependency manifests and lockfile, native source and media-picker path remain those of 1.0.5. No runtime relabeling or new native-module dependency. Composer recovery changes from 1.0.6 are excluded.

Verification on Node 20.19.6:

- 48 client tests passed, including the screenshot error, API normalization and final SDK filters.
- Client and server TypeScript passed.
- Both production-environment OTA bundles exported successfully.
- The old server snapshot referenced a missing event-story visibility helper. Restored the existing helper from the verified newer branch, including its approved/private-team/contributor rules and request-aware callsites. All three event-story API tests passed after this repair; before repair they returned 500. This source repair is not deployed by OTA.
- No iPhone Photos acquisition test claimed. Server deployment and native binaries are outside this OTA action.
