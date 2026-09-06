/** Execute the live receipt handler with controlled signature/DB dependencies.
 * Signature cryptography and database settlement are covered separately.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import { sendError } from '../lib/http/sendError.js';
import { appleAdTransactionSchema } from '../lib/appleAdTransaction.js';
const source = readFileSync(new URL('../routes/payments.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('payments.ts', source, ts.ScriptTarget.Latest, true);
let handler: ts.Node | undefined;
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === '/apple/verify-ad-receipt'
  ) {
    const wrapper = node.arguments[node.arguments.length - 1] as ts.CallExpression;
    handler = wrapper.arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!handler) throw new Error('Live Apple ad receipt handler not found');
const executable = ts.transpileModule(`exports.handler = ${handler.getText(ast)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
async function verify(
  tokens: string[],
  totalCents = 200,
  signedFields: Record<string, unknown> = {}
) {
  let finalized = 0,
    status = 200;
  let body: any;
  const failures: unknown[] = [];
  const context: any = {
    exports: {},
    sendError,
    appleAdTransactionSchema,
    z,
    adDateSchema: z.string(),
    process: { env: { NODE_ENV: 'production' } },
    enforceVerifiedForAdPaymentFlow: async () => true,
    getDatesPastBookingHorizon: () => [],
    prisma: {
      ad: {
        findUnique: async () => ({
          id: 'ad',
          user_id: 'user',
          status: 'approved',
          target_zip_code: null,
        }),
      },
    },
    calculateAdPriceCents: () => ({ totalCents }),
    APPLE_AD_PRODUCTS: ['MOND_THURS'],
    AD_PRODUCT_CENTS: { MOND_THURS: 100 },
    verifyAppleSignedJws: (token: string) => ({
      productId: 'MOND_THURS',
      quantity: 1,
      transactionId: token === 'missing-id' ? undefined : token,
      ...signedFields,
    }),
    ensureApplePendingTransactionLog: async () => {},
    normalizeAppleTransactionIds: (ids: string[]) => [...new Set(ids)],
    finalizeAppleAdPurchase: async () => {
      finalized++;
      return { ok: true };
    },
    debugLog: () => {},
    console,
    captureException: (_error: unknown, context: unknown) => failures.push(context),
    isUniqueConstraintError: () => false,
  };
  vm.runInNewContext(executable, context);
  const response = {
    status: (value: number) => {
      status = value;
      return response;
    },
    json: (value: unknown) => {
      body = value;
      return response;
    },
  };
  await context.exports.handler(
    {
      user: { id: 'user' },
      body: {
        ad_id: 'ad',
        dates: ['2026-09-07'],
        receipts: tokens.map(jws => ({ jws, productId: 'MOND_THURS' })),
      },
    },
    response
  );
  return { status, body, finalized, failures };
}
describe('Apple ad receipt value boundaries', () => {
  it.each([
    { revocationDate: 1 },
    { quantity: 'not-a-number' },
    { quantity: 1.5 },
    { quantity: 0 },
    { quantity: -1 },
    { quantity: Infinity },
  ])('rejects invalid or revoked signed payment data before fulfillment: %j', async fields => {
    const result = await verify(['first'], 100, fields);
    expect(result.status).toBe(400);
    expect(result.finalized).toBe(0);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        context: 'apple_ad_receipt_boundary',
        failure_code:
          fields.revocationDate !== undefined
            ? 'REVOKED_TRANSACTION'
            : 'INVALID_SIGNED_TRANSACTION',
      })
    );
  });
  it('rejects repeated transaction IDs before fulfillment, including concurrent requests', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(['same', 'same'])));
    for (const result of results) {
      expect(result.status).toBe(400);
      expect(result.finalized).toBe(0);
    }
  });
  it('requires an identity for every receipt, not just one receipt in the bundle', async () => {
    const result = await verify(['valid', 'missing-id']);
    expect(result.status).toBe(400);
    expect(result.finalized).toBe(0);
  });
  it('accepts the same total backed by distinct transactions', async () => {
    expect(await verify(['first', 'second'])).toMatchObject({ status: 200, finalized: 1 });
  });
  it('counts a repeated fully-funded receipt once without breaking idempotent delivery', async () => {
    expect(await verify(['same', 'same'], 100)).toMatchObject({ status: 200, finalized: 1 });
  });
});
