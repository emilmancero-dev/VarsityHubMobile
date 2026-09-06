import { z } from 'zod';

// Applied only after Apple's cryptographic verification, on both legacy and
// intent-bound paths. Signed refunds are authentic but cannot fund fulfillment.
export const appleAdTransactionSchema = z.object({
  productId: z.enum(['MOND_THURS', 'FRI_SUN']),
  transactionId: z.string().trim().min(1).max(100),
  quantity: z.number().int().min(1).max(9).default(1),
  revocationDate: z.never().optional(),
});
