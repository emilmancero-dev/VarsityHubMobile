# Error disclosure audit — September 10, 2026

Status: confirmed leaks fixed locally; not deployed.

## Scope and threat model

Reviewed errors crossing the client display boundary and the server response boundary. The risk is disclosure of native implementation details, provider diagnostics, database/schema details, credential fragments, and signed material to a caller. Hiding an alert does not protect an API response, so both boundaries were examined.

The automated scan covers 692 TypeScript/TSX runtime files across app, components, hooks, utils, context, lib, apiclient, config, shared, and server/src. Tests, generated distributions, and dependencies are excluded. Manual review covered the shared error helpers, upload handlers, authentication, payments, health checks, structured business exceptions, production error boundaries, and error messages assembled through local aliases.

## Confirmed findings and changes

| Finding                                                     | Before / reproduction                                                                                                                                | After                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Client sanitizer allowed unknown diagnostics                | `sanitizeMessage('PHPhotosErrorDomain error 3164.')` returned the native error; arbitrary short text also passed.                                    | Exact reviewed public strings or approved code-to-message mappings only; unknown errors use developer-authored fallbacks.                   |
| Alternate display paths bypassed the sanitizer              | `extractApiError`, upload alerts, query-error screens, native purchase errors, and several action modals displayed raw error text.                   | Shared safe-message helper used at those display boundaries; classification still reads raw errors where needed.                            |
| Payment and game responses exposed exception details        | Subscription lookup failures included `detail: err.message`; bulk game failures returned database exception details; checkout used a small denylist. | Authored response text, no exception details or configuration variable names.                                                               |
| Provider errors could impersonate public application errors | Several catches accepted any object with numeric `statusCode` or a `body` property.                                                                  | Locally authored exceptions use `AppError`; handlers require that class before serializing them. Status codes alone do not establish trust. |
| Private metadata was public by default                      | `AppError.toJSON()` copied arbitrary diagnostic metadata, including authentication provider failure details.                                         | Diagnostic `metadata` stays private. Only explicitly selected `publicMetadata` is serialized.                                               |
| Health probes exposed credential material                   | The health-secret-protected Cloudinary probe returned credential prefixes, a partial secret, and a generated sample signature.                       | Those fields and raw provider messages are removed on both success and failure. Health-secret authorization remains required.               |
| Development responses could expose raw exceptions           | Unknown-error middleware and test endpoints included exception messages/stacks outside production.                                                   | Those server responses also use fixed public text.                                                                                          |

No evidence of credential theft or exploitation was established by this source audit. The original screenshot contained a native iOS error identifier, not a credential.

## Ongoing enforcement

`npm run verify:error-envelope` now also runs `scripts/check-error-disclosure.cjs` against the complete current working tree. It checks common UI setters, alerts, modals, JSX, and server JSON/text responses; follows local initializers and assignments; recognizes catch variables and bracket property access; and rejects untrusted error text used as a sanitizer fallback.

Regression tests cover arbitrary unknown diagnostics, the screenshot's native error, upload-provider errors, safe business-code messages, private metadata, development responses, health-check failures/success, and the scanner itself.

Rules for future changes:

- Error display copy must come from `toUserMessage` / `toAuthErrorMessage` or a developer-authored literal. A fallback must never come from an error or response.
- Add helpful messages through reviewed, fixed code mappings. Do not reinstate substring denylists or raw-message fallback behavior.
- Use typed application errors for intentional public failures. Provider status/body fields are untrusted.
- Keep diagnostic metadata out of responses. Review every new `publicMetadata` field.

## Verification

- Client: 39 tests passed in `toUserMessage`, `apiErrors`, and `upload-error-disclosure` suites.
- Server: 73 tests passed across error handling, malformed URLs, health disclosure, organization invite guards, authentication code contracts, media upload sessions, payment finalization, and team entitlements.
- Scanner: four tests passed; 692 runtime source files scanned with zero flagged flows.
- Client and server TypeScript checks passed.
- ESLint on touched client source returned zero errors, with warnings for existing broad typing/hook/console patterns and ignored test files.
- Formatting, conflict-marker scan, diff whitespace check, and error-envelope/disclosure checks passed.

## Compatibility and limits

Unknown failures now show less-specific but safe copy. Known business codes retain helpful messages. Typed business errors retain their status and error identifiers; explicit limit/current metadata uses the standard `details`/`metadata` envelope. Validation issues and rate-limit retry metadata remain explicitly public. No database migration is required.

This is a source audit plus focused regression testing, not a proof that disclosure is impossible. The scanner is deliberately bounded: it does not establish arbitrary cross-function dataflow or inspect third-party native code, reverse-proxy error pages, historical responses, production bundles, or access controls/retention for private logs and telemetry. Existing development-only client error details remain behind `__DEV__`. Raw diagnostic logging is not treated as public UI, and this audit does not certify all private logging as fully redacted.

Existing unrelated workspace changes were preserved. Nothing was committed, pushed, or deployed. Server changes require the normal reviewed/tested Railway release. Installed clients require `eas update --branch production` after the client release checks. No native configuration was changed by this task.
