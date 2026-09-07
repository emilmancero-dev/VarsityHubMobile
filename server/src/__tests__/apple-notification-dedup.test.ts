import { describe, expect, it, jest } from '@jest/globals';

import { recordAppleNotificationReceipt } from '../lib/appleNotificationDedup.js';

describe('recordAppleNotificationReceipt', () => {
  it('records a new Apple notification receipt once', async () => {
    const create = jest.fn(async () => ({ id: 'tx-1' }));

    const result = await recordAppleNotificationReceipt(
      { transactionLog: { create } },
      {
        notificationUUID: 'notif-123',
        originalTransactionId: 'orig-123',
        productId: 'legend.monthly',
        environment: 'Production',
        expiresDate: Date.parse('2026-05-10T18:00:00.000Z'),
        notificationType: 'DID_RENEW',
        subtype: 'INITIAL_BUY',
      }
    );

    expect(result).toBe('recorded');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apple_transaction_id: 'notif-123',
          transaction_type: 'APPLE_S2S_NOTIFICATION',
          status: 'RECEIVED',
        }),
      })
    );
  });

  it('returns duplicate on unique conflicts instead of replaying side effects', async () => {
    const create = jest.fn(async () => {
      const err: any = new Error('duplicate');
      err.code = 'P2002';
      throw err;
    });

    const result = await recordAppleNotificationReceipt(
      { transactionLog: { create } },
      {
        notificationUUID: 'notif-123',
        originalTransactionId: 'orig-123',
        productId: 'legend.monthly',
        environment: 'Production',
        notificationType: 'DID_RENEW',
        subtype: null,
      }
    );

    expect(result).toBe('duplicate');
  });

  it('returns missing_uuid when Apple payload does not provide a notification UUID', async () => {
    const create = jest.fn();

    const result = await recordAppleNotificationReceipt(
      { transactionLog: { create: create as any } },
      {
        notificationUUID: '',
        originalTransactionId: 'orig-123',
        productId: 'legend.monthly',
        environment: 'Production',
        notificationType: 'DID_RENEW',
        subtype: null,
      }
    );

    expect(result).toBe('missing_uuid');
    expect(create).not.toHaveBeenCalled();
  });
});
