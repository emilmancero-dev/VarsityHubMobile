<!-- EVIDENCE-STATUS: PENDING -->

# Device evidence — FLOW-AD-PURCHASE

**Workflow:** Price → purchase → verify → activate an advertisement (risk:
critical). This file is both the runbook and the recorded evidence. The matrix
auditor (`scripts/audit-matrix.cjs`) reads it: the workflow stays release-
blocking until the top-of-file sentinel is `EVIDENCE-STATUS: COMPLETE` **and**
`config/commandment-workflows.json` → `FLOW-AD-PURCHASE.status` is `verified`.
Do not mark it complete without a real recorded run.

## What automation already proves (no device needed)

- `iap-config-invariants.test.ts` — client $ prices, `adPricing` util, and
  `AD_PRODUCT_CENTS` stay pinned; 56-day booking horizon pinned client + server.
- `stripe-webhook-signature.test.ts` — unsigned webhook is rejected (400).

Automation can't prove the installed-app purchase → receipt verify → activation
chain end-to-end. That is what this device run records.

## Preconditions

- An **installed build** (TestFlight / internal, or a dev-client build), NOT
  Expo Go. Note the app `version` and OTA runtime (`1.0.5` or `1.0.6`).
- **iOS:** a Sandbox Apple ID (Settings → Developer → Sandbox Apple Account);
  ad IAP products `MOND_THURS` ($4.99) and `FRI_SUN` ($7.99) in
  "Ready to Submit" in App Store Connect.
- **Android/web:** Stripe in **test mode**; use a test card (`4242…`).
- A signed-in account able to book ads (business/advertiser).
- Optional: tail Railway logs to watch the verify endpoints fire.

## Purchase journey (the app path)

1. Ad entry → `app/ad-calendar.tsx`: pick a zip, pick dates (M–Th vs F–Su drives
   the product). Quote comes from `POST /payments/ad-quote`; availability from
   `GET /ads/availability`.
2. Reserve + create the ad (`POST /ads/reservations`, `POST /ads`), then pay:
   - **iOS:** `useAdIAP` → Apple IAP for `MOND_THURS` / `FRI_SUN`; the receipt
     posts to `POST /payments/apple/verify-ad-receipt` (JWS verified, product +
     price checked against `AD_PRODUCT_CENTS`).
   - **Android/web:** Stripe PaymentSheet via `POST /payments/create-payment-sheet`.
3. `app/ad-confirmation.tsx` shows success; ad → `submit-for-approval`; after
   moderation it goes live for viewers in the zip.

---

## Recorded run

Fill every field. Attach screenshots to `docs/release/device-evidence/assets/`
and reference them. Leave a case FAIL'd (with a note) rather than faking a pass.

| Field                          | Value                         |
| ------------------------------ | ----------------------------- |
| App version / runtime          | `<x.y.z / 1.0.x>`             |
| Build (TestFlight # or commit) | `<…>`                         |
| Tester                         | `<name>`                      |
| Date                           | `<YYYY-MM-DD>`                |
| Environment                    | `<iOS sandbox / Stripe test>` |

### iOS sandbox: MOND_THURS ($4.99) purchase verified and ad activated

- Steps: book a Mon–Thu date, pay with the sandbox account.
- Expected: `verify-ad-receipt` returns success; charge = $4.99; ad reservation
  created; ad reaches pending-approval then active.
- Transaction id: `<…>` · Screenshot: `<…>` · **Result: PASS / FAIL** `<note>`

### iOS sandbox: FRI_SUN ($7.99) purchase verified and ad activated

- Steps: book a Fri–Sun date, pay with the sandbox account.
- Expected: charge = $7.99; verify + reservation + activation as above.
- Transaction id: `<…>` · Screenshot: `<…>` · **Result: PASS / FAIL** `<note>`

### Android/web: Stripe PaymentSheet purchase verified and ad activated

- Steps: same booking on Android (or web) with a Stripe test card.
- Expected: PaymentSheet succeeds; webhook confirms; reservation + activation.
- PaymentIntent id: `<…>` · Screenshot: `<…>` · **Result: PASS / FAIL** `<note>`

### Replay of the same receipt does not double-charge or double-activate

- Steps: re-submit the same receipt / retry the same purchase.
- Expected: idempotent — no second charge, no duplicate reservation
  (`apple-notification-dedup` / webhook idempotency behavior on a real device).
- Evidence: `<…>` · **Result: PASS / FAIL** `<note>`

---

## To clear the gate (only after all four are PASS)

1. Change the sentinel on line 1 to `<!-- EVIDENCE-STATUS: COMPLETE -->`.
2. In `config/commandment-workflows.json`, set `FLOW-AD-PURCHASE.status` to
   `"verified"` and remove/settle `blockedBy`.
3. `npm run audit:matrix` — `workflow-readiness` should now PASS (18/18).
4. Commit both files together with the run date in the message.
