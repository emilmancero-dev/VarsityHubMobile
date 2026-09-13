/**
 * Ad lifecycle structural invariants.
 *
 * These tests pin the ad status/payment_status state machine to the code that
 * exists today. The goal is not to invent a cleaner ad model than production
 * has; it is to make the current lifecycle explicit so future changes cannot
 * silently introduce impossible or contradictory tuples.
 *
 * If one of these tests fails, update the backend state transition, not the
 * invariant, unless the product/state-machine change is intentional.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_ROOT = process.cwd();
const SRC_ROOT = join(SERVER_ROOT, 'src');

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

const schema = read(SERVER_ROOT, 'prisma', 'schema.prisma');
const ads = read(SRC_ROOT, 'routes', 'ads.ts');
const payments = read(SRC_ROOT, 'routes', 'payments.ts');
const paymentInternals = read(SRC_ROOT, 'lib', 'paymentInternals.ts');
const approvalService = read(SRC_ROOT, 'lib', 'approvalService.ts');
const overnightTasks = read(SRC_ROOT, 'cron', 'overnightTasks.ts');

function parseEnum(source: string, enumName: string): string[] {
  const match = source.match(new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\n\\}`, 'm'));
  expect(match).toBeTruthy();
  return (match![1] || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('//'));
}

function sliceFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + 5000);
}

const AD_STATUSES = parseEnum(schema, 'AdStatus');
const AD_PAYMENT_STATUSES = parseEnum(schema, 'AdPaymentStatus');

// These are the tuples the backend currently encodes. Some are awkward
// (`active + hold`, `active + unpaid`) but they are real consequences of the
// current "reuse an existing ad for another booking" model, so the invariant
// must describe them honestly until that model is redesigned.
const ALLOWED_TUPLES = [
  'active/hold',
  'active/paid',
  'active/unpaid',
  'approved/hold',
  'approved/paid',
  'approved/pending_approval',
  'approved/unpaid',
  'archived/paid',
  'archived/unpaid',
  'draft/refund_pending',
  'draft/refunded',
  'draft/unpaid',
  'pending/paid',
  'pending/pending_approval',
] as const;

const ALLOWED_TUPLE_SET = new Set(ALLOWED_TUPLES);

function expectAllowedTuple(status: string, paymentStatus: string) {
  expect(
    ALLOWED_TUPLE_SET.has(`${status}/${paymentStatus}` as (typeof ALLOWED_TUPLES)[number])
  ).toBe(true);
}

describe('ad lifecycle structural invariants', () => {
  it('pins the AdStatus enum surface', () => {
    expect(AD_STATUSES).toEqual(['draft', 'pending', 'active', 'approved', 'rejected', 'archived']);
  });

  it('pins the AdPaymentStatus enum surface', () => {
    expect(AD_PAYMENT_STATUSES).toEqual([
      'unpaid',
      'pending_approval',
      'hold',
      'paid',
      'refund_pending',
      'refunded',
      // Terminal manual-review state for rejected Apple-IAP-paid ads (audit
      // 2026-07-14) — the server cannot issue Apple refunds.
      'manual_refund_review',
    ]);
  });

  it('allowed tuples only reference declared enum members', () => {
    for (const tuple of ALLOWED_TUPLES) {
      const [status, paymentStatus] = tuple.split('/');
      expect(AD_STATUSES).toContain(status);
      expect(AD_PAYMENT_STATUSES).toContain(paymentStatus);
    }
  });

  it('draft creation and submit-for-approval transitions stay explicit', () => {
    // Draft creation uses a ternary (bypassApproval ? 'approved' : 'draft') for App Review accounts;
    // the nominal path always produces 'draft'. Verify the ternary + 'unpaid' literal.
    expect(ads).toMatch(
      /bypassApproval\s*\?\s*'approved'\s*:\s*'draft',\s*\n\s*payment_status:\s*'unpaid'/
    );
    expect(ads).toMatch(
      /data:\s*\{\s*status:\s*'pending',\s*payment_status:\s*'pending_approval'\s*\}/
    );
    expectAllowedTuple('draft', 'unpaid');
    expectAllowedTuple('pending', 'pending_approval');
  });

  it('admin approval and rejection keep ads inside the allowed tuple set', () => {
    const approveAd = sliceFunction(approvalService, 'export async function approveAd');
    // A PAID ad re-approved (e.g. after a post-payment content edit bounced it
    // back to `pending`) must return to `active` so it re-enters the feed —
    // `/for-feed` requires status:'active' AND payment_status:'paid'. An UNPAID
    // ad approves to `approved` and still waits for payment before going live.
    expect(approveAd).toMatch(/status:\s*ad\.payment_status === 'paid' \? 'active' : 'approved'/);
    expect(approveAd).toMatch(
      /payment_status:\s*ad\.payment_status === 'paid' \? 'paid' : 'unpaid'/
    );
    expectAllowedTuple('active', 'paid');
    expectAllowedTuple('approved', 'unpaid');

    const rejectAd = sliceFunction(approvalService, 'export async function rejectAd');
    expect(rejectAd).toMatch(/status:\s*'draft'/);
    expect(rejectAd).toMatch(
      /payment_status:\s*ad\.payment_status === 'paid' \? 'refund_pending' : 'unpaid'/
    );
    expect(rejectAd).toMatch(/data:\s*\{\s*payment_status:\s*'refunded'\s*\}/);
    expectAllowedTuple('draft', 'refund_pending');
    expectAllowedTuple('draft', 'unpaid');
    expectAllowedTuple('draft', 'refunded');
  });

  it('content edits trigger re-review by moving status back to pending without inventing a new payment state', () => {
    const updateRoute = sliceFunction(ads, 'adsRouter.put(');
    expect(updateRoute).toMatch(/const requiresReapproval/);
    expect(updateRoute).toMatch(/data\.status = 'pending'/);
    expect(updateRoute).not.toMatch(/data\.payment_status\s*=/);
    // Current live model: re-review can happen before payment or after payment.
    expectAllowedTuple('pending', 'pending_approval');
    expectAllowedTuple('pending', 'paid');
  });

  it('reserveAdSlots is the only hold/paid reservation writer and only writes hold or paid', () => {
    const reserveAdSlots = sliceFunction(paymentInternals, 'export async function reserveAdSlots');
    expect(reserveAdSlots).toMatch(/paymentStatus:\s*'hold' \| 'paid'/);
    expect(reserveAdSlots).toMatch(/payment_status:\s*params\.paymentStatus/);
  });

  it('checkout entrypoints create holds, and successful finalization always lands on active + paid', () => {
    const paymentSources = [payments, paymentInternals].join('\n');
    const holdCalls = paymentSources.match(/paymentStatus:\s*'hold'/g) || [];
    expect(holdCalls.length).toBeGreaterThanOrEqual(2);

    // activateApprovedAdPaymentIntent used to be dead code (defined, never
    // called) while the webhook ran a separately-duplicated inline copy of the
    // same logic — that's how this used to count 3. The webhook now calls the
    // shared helper instead of duplicating it, so the literal only needs to
    // appear once per file: the helper's own write, plus paymentInternals.ts.
    const paidActiveWrites =
      paymentSources.match(/payment_status:\s*'paid',\s*status:\s*'active'/g) || [];
    expect(paidActiveWrites.length).toBeGreaterThanOrEqual(2);
    expect(payments).toMatch(/async function activateApprovedAdPaymentIntent/);
    expect(payments).toMatch(/await activateApprovedAdPaymentIntent\(/);

    expectAllowedTuple('approved', 'hold');
    expectAllowedTuple('active', 'hold');
    expectAllowedTuple('active', 'paid');
  });

  it('hold release paths fall back to unpaid rather than leaving a paid/pending tuple behind', () => {
    const unpaidReleases = payments.match(/data:\s*\{\s*payment_status:\s*'unpaid'\s*\}/g) || [];
    expect(unpaidReleases.length).toBeGreaterThanOrEqual(3);
    expect(overnightTasks).toMatch(/data:\s*\{\s*payment_status:\s*'unpaid'\s*\}/);
    expect(overnightTasks).toMatch(/status:\s*'pending',\s*payment_status:\s*'pending_approval'/);
    expect(overnightTasks).toMatch(
      /data:\s*\{[\s\S]*status:\s*'draft',[\s\S]*payment_status:\s*'unpaid'[\s\S]*\}/
    );

    expectAllowedTuple('approved', 'unpaid');
    expectAllowedTuple('active', 'unpaid');
  });

  it('slot-full refund recovery explicitly releases reservations before marking the transaction refunded', () => {
    const slotFullReleaseHelper = sliceFunction(
      paymentInternals,
      'export async function releaseAdInventoryAfterSlotFullRefund'
    );
    expect(slotFullReleaseHelper).toMatch(/adReservation\.deleteMany/);
    expect(slotFullReleaseHelper).toMatch(
      /payment_status:\s*\{\s*in:\s*\['hold', 'pending_approval'\]\s*\}/
    );
    expect(slotFullReleaseHelper).toMatch(/data:\s*\{\s*payment_status:\s*'unpaid'\s*\}/);

    const releaseCalls =
      [payments, paymentInternals].join('\n').match(/releaseAdInventoryAfterSlotFullRefund\(/g) ||
      [];
    expect(releaseCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('slot-full refund failures that happen after Stripe refund are flagged for recovery instead of pretending the refund failed', () => {
    expect(payments).toMatch(/releaseAdInventoryAfterSlotFullRefundWithRetry/);
    expect(payments).toMatch(/updateTransactionStatus\([^)]*,\s*'NEEDS_REVIEW'/);
    expect(payments).toMatch(/release_pending:\s*true/);
    expect(overnightTasks).toMatch(/export async function recoverSlotFullRefundReleaseFailures/);
    expect(overnightTasks).toMatch(/status:\s*'REFUNDED'/);
    expect(overnightTasks).toMatch(/release_pending:\s*false/);
  });

  it('refund and archive paths use the currently supported terminal tuples', () => {
    expect(payments).toMatch(/data:\s*\{\s*status:\s*'draft',\s*payment_status:\s*'refunded'\s*\}/);

    expect(overnightTasks).toMatch(/status:\s*'active',\s*payment_status:\s*'paid'/);
    expect(overnightTasks).toMatch(/payment_status:\s*'unpaid',\s*status:\s*'approved'/);
    expect(overnightTasks).toMatch(/data:\s*\{\s*status:\s*'archived'\s*\}/);

    expectAllowedTuple('archived', 'paid');
    expectAllowedTuple('archived', 'unpaid');
    expectAllowedTuple('draft', 'refunded');
  });

  it('no ad approval path uses status=rejected; rejection is represented as a draft requiring changes', () => {
    const rejectAd = sliceFunction(approvalService, 'export async function rejectAd');
    expect(rejectAd).not.toMatch(/status:\s*'rejected'/);
    expect(rejectAd).toMatch(/status:\s*'draft'/);
  });

  it('explicit literal ad tuples written by lifecycle code are all in the allowed set', () => {
    const combined = [ads, payments, paymentInternals, approvalService, overnightTasks].join('\n');
    const found = new Set<string>();

    for (const match of combined.matchAll(
      /status:\s*'([a-z_]+)'\s*,\s*payment_status:\s*'([a-z_]+)'/g
    )) {
      found.add(`${match[1]}/${match[2]}`);
    }
    for (const match of combined.matchAll(
      /payment_status:\s*'([a-z_]+)'\s*,\s*status:\s*'([a-z_]+)'/g
    )) {
      found.add(`${match[2]}/${match[1]}`);
    }

    expect(found.size).toBeGreaterThan(0);
    for (const tuple of found) {
      expect(ALLOWED_TUPLE_SET.has(tuple as (typeof ALLOWED_TUPLES)[number])).toBe(true);
    }
  });
});
