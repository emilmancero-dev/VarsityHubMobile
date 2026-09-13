import { toUserMessage } from '@/utils/toUserMessage';
/**
 * useAdIAP — IAP for ad hosting (MOND_THURS, FRI_SUN).
 * iOS: Apple IAP. Android: Stripe fallback.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { httpPost } from '@/api/http';
import { captureBreadcrumb } from '@/utils/sentry';

const isExpoGo = Constants.executionEnvironment === 'storeClient';
const isNativeMobile = Platform.OS === 'ios' || Platform.OS === 'android';
let useRNIAP: any = () => ({});
let getReceiptIOS: any = async () => '';
if (!isExpoGo && isNativeMobile) {
  try {
    if (Platform.OS !== 'web') {
      const iap = require('react-native-iap');
      useRNIAP = iap.useIAP;
      getReceiptIOS = iap.getReceiptIOS;
    }
  } catch (err) {
    if (__DEV__)
      console.warn(
        '[useAdIAP] react-native-iap not available (e.g. Expo Go):',
        (err as Error)?.message
      );
  }
}

const isIOS = Platform.OS === 'ios';
const IOS_BUNDLE_ID =
  Application.applicationId ||
  Constants.expoConfig?.ios?.bundleIdentifier ||
  'com.varsithub.varsityhub-ios';

export const AD_IAP_PRODUCT_IDS = {
  weekday: 'MOND_THURS',
  weekend: 'FRI_SUN',
} as const;

const AD_SKUS = [AD_IAP_PRODUCT_IDS.weekday, AD_IAP_PRODUCT_IDS.weekend];

type PendingAd = {
  adId: string;
  dates: string[];
  receipts: { jws?: string | null; receipt?: string; productId: string; quantity: number }[];
  weekdayBlocks: number;
  weekendBlocks: number;
  resolve: (result: { ok: boolean; error?: string }) => void;
};

const pendingAdRef = { current: null as PendingAd | null };
const PENDING_AD_IAP_KEY = 'vh_pending_ad_iap_receipt_verifications_v1';

type PendingAdVerification = {
  id: string;
  adId: string;
  dates: string[];
  receipts: { jws?: string | null; receipt?: string; productId: string; quantity: number }[];
  attemptCount: number;
  createdAt: number;
};

let flushQueuePromise: Promise<void> | null = null;
const PENDING_AD_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

async function readPendingAdVerifications(): Promise<PendingAdVerification[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_AD_IAP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((item: any) => {
      const createdAt = Number(item?.createdAt || 0);
      return (
        item &&
        typeof item.id === 'string' &&
        typeof item.adId === 'string' &&
        Array.isArray(item.dates) &&
        Array.isArray(item.receipts) &&
        Number.isFinite(createdAt) &&
        now - createdAt <= PENDING_AD_VERIFICATION_TTL_MS
      );
    });
  } catch {
    return [];
  }
}

async function writePendingAdVerifications(items: PendingAdVerification[]) {
  if (items.length === 0) {
    await AsyncStorage.removeItem(PENDING_AD_IAP_KEY).catch(() => {});
    return;
  }
  await AsyncStorage.setItem(PENDING_AD_IAP_KEY, JSON.stringify(items)).catch(() => {});
}

async function enqueuePendingAdVerification(item: PendingAdVerification) {
  const existing = await readPendingAdVerifications();
  await writePendingAdVerifications([...existing.filter(entry => entry.id !== item.id), item]);
}

async function submitAdVerification(item: PendingAdVerification) {
  await httpPost('/payments/apple/verify-ad-receipt', {
    ad_id: item.adId,
    dates: item.dates,
    receipts: item.receipts,
  });
}

function getVerificationErrorMessage(err: any) {
  return toUserMessage(err, 'Receipt verification is taking longer than usual');
}

export async function flushPendingAdVerifications(onError?: (message: string) => void) {
  if (flushQueuePromise) return flushQueuePromise;

  flushQueuePromise = (async () => {
    const queue = await readPendingAdVerifications();
    if (queue.length === 0) return;

    const remaining: PendingAdVerification[] = [];
    for (const item of queue) {
      try {
        await submitAdVerification(item);
      } catch (err: any) {
        const message = getVerificationErrorMessage(err);
        onError?.(message);
        remaining.push({
          ...item,
          attemptCount: item.attemptCount + 1,
        });
        if (__DEV__) console.error('[useAdIAP] background verify-ad-receipt error:', err);
      }
    }

    await writePendingAdVerifications(remaining);
  })().finally(() => {
    flushQueuePromise = null;
  });

  return flushQueuePromise;
}

export function useAdIAP() {
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availableProductIdsRef = useRef<string[]>([]);
  const fetchProductsPromiseRef = useRef<Promise<void> | null>(null);

  const queueAdVerificationRecovery = useCallback(async (item: PendingAdVerification, err: any) => {
    await enqueuePendingAdVerification(item);
    const message = getVerificationErrorMessage(err);
    setError(message);
    if (__DEV__) console.error('[useAdIAP] verify-ad-receipt queued for retry:', err);
    void flushPendingAdVerifications(flushMessage => {
      setError(flushMessage);
    });
  }, []);

  const {
    connected,
    products,
    fetchProducts,
    requestPurchase: rnRequestPurchase,
    finishTransaction: rnFinishTransaction,
  } = useRNIAP({
    onPurchaseSuccess: async (purchase: any) => {
      const pending = pendingAdRef.current;
      if (!pending || !isIOS) return;
      const pid = purchase?.productId;
      if (pid !== AD_IAP_PRODUCT_IDS.weekday && pid !== AD_IAP_PRODUCT_IDS.weekend) return;
      captureBreadcrumb('Ad store purchase received', 'payments.ad', {
        product_id: pid,
        ad_id: pending.adId,
      });

      try {
        let receipt: string | undefined;
        const jws = (purchase as any).purchaseToken || null;
        if (!jws) {
          try {
            receipt = await getReceiptIOS();
            captureBreadcrumb('Ad receipt fetched', 'payments.ad', {
              product_id: pid,
              source: 'getReceiptIOS',
            });
          } catch {
            receipt = (purchase as any).transactionReceipt;
            captureBreadcrumb(
              'Ad receipt fallback used',
              'payments.ad',
              {
                product_id: pid,
                source: 'transactionReceipt',
              },
              'warning'
            );
          }
        }
        if (jws || receipt) {
          pending.receipts.push({
            jws,
            receipt,
            productId: pid,
            quantity: (purchase as any).quantity ?? 1,
          });
        }
        captureBreadcrumb('Ad store transaction finish started', 'payments.ad', {
          product_id: pid,
          ad_id: pending.adId,
        });
        await rnFinishTransaction({ purchase, isConsumable: true });
        captureBreadcrumb('Ad store transaction finished', 'payments.ad', {
          product_id: pid,
          ad_id: pending.adId,
        });
      } catch (err) {
        if (__DEV__) console.warn('[useAdIAP] Receipt/finish failed:', (err as Error)?.message);
        captureBreadcrumb(
          'Ad purchase processing failed',
          'payments.ad',
          {
            product_id: pid,
            ad_id: pending.adId,
            error: (err as Error)?.message || 'unknown_error',
          },
          'warning'
        );
      }

      const { weekdayBlocks, weekendBlocks } = pending;
      const hasWeekday = pending.receipts.some(r => r.productId === AD_IAP_PRODUCT_IDS.weekday);
      const hasWeekend = pending.receipts.some(r => r.productId === AD_IAP_PRODUCT_IDS.weekend);
      const needWeekday = weekdayBlocks > 0;
      const needWeekend = weekendBlocks > 0;
      const complete = (needWeekday ? hasWeekday : true) && (needWeekend ? hasWeekend : true);

      if (complete) {
        const verification: PendingAdVerification = {
          id: `${pending.adId}:${Date.now()}`,
          adId: pending.adId,
          dates: pending.dates,
          receipts: pending.receipts,
          attemptCount: 0,
          createdAt: Date.now(),
        };

        pendingAdRef.current = null;
        setPurchasing(false);

        captureBreadcrumb('Ad receipt verification started', 'payments.ad', {
          ad_id: pending.adId,
          receipts_count: pending.receipts.length,
          weekday_blocks: weekdayBlocks,
          weekend_blocks: weekendBlocks,
        });
        try {
          await submitAdVerification(verification);
          captureBreadcrumb('Ad receipt verification completed', 'payments.ad', {
            ad_id: pending.adId,
            receipts_count: pending.receipts.length,
          });
          // Resolve success only after server has activated the ad booking.
          pending.resolve({ ok: true });
        } catch (err: any) {
          captureBreadcrumb(
            'Ad receipt verification deferred',
            'payments.ad',
            {
              ad_id: pending.adId,
              error: err?.message || 'unknown_error',
            },
            'warning'
          );
          void queueAdVerificationRecovery(verification, err);
          // Consumable was already finished with StoreKit above; queue recovery
          // will retry server activation. Resolve with an error so the caller
          // can surface a "processing" state rather than a false success.
          pending.resolve({
            ok: false,
            error: 'Ad activation is being retried. You will not be charged again.',
          });
        }
      } else if (needWeekend && !hasWeekend) {
        // Set a 2-minute timeout to prevent UI getting stuck if Apple IAP stalls
        const iapTimeout = setTimeout(() => {
          const p = pendingAdRef.current;
          if (p) {
            pendingAdRef.current = null;
            p.resolve({ ok: false, error: 'Purchase timed out. Please try again.' });
          }
          setPurchasing(false);
        }, 120000);
        rnRequestPurchase({
          type: 'in-app',
          request: { apple: { sku: AD_IAP_PRODUCT_IDS.weekend, quantity: weekendBlocks } },
        }).catch(() => {
          clearTimeout(iapTimeout);
        });
      }
    },
    onPurchaseError: (err: any) => {
      const msg = err?.message || '';
      if (msg.toLowerCase().includes('cancel') || err?.code === 'E_USER_CANCELLED') {
        captureBreadcrumb(
          'Ad purchase cancelled',
          'payments.ad',
          {
            code: err?.code,
          },
          'info'
        );
        const p = pendingAdRef.current;
        if (p) {
          pendingAdRef.current = null;
          p.resolve({ ok: false });
        }
        setPurchasing(false);
        setError(null);
        return;
      }
      if (__DEV__) console.warn('[useAdIAP] purchase error:', err);
      captureBreadcrumb(
        'Ad purchase failed',
        'payments.ad',
        {
          code: err?.code,
          error: msg || 'unknown_error',
        },
        'error'
      );
      const errMsg = toUserMessage(err, 'Purchase failed. Please try again.');
      const p = pendingAdRef.current;
      if (p) {
        pendingAdRef.current = null;
        p.resolve({ ok: false, error: errMsg });
      }
      setPurchasing(false);
      setError(errMsg);
    },
  });

  const availableProductIds = useMemo<string[]>(() => {
    const productIds: string[] = (products || [])
      // react-native-iap v14 (Nitro) exposes the product identifier as `id`;
      // older versions used `productId`. Read `id` first, fall back for safety.
      // Reading `productId` only makes this list always empty on v14, which
      // surfaces as "Apple ad products unavailable for this build".
      .map((product: any) => {
        const id = product?.id ?? product?.productId;
        return typeof id === 'string' ? id : '';
      })
      .filter((productId: string) => productId.length > 0);
    return [...new Set<string>(productIds)].sort();
  }, [products]);

  useEffect(() => {
    availableProductIdsRef.current = availableProductIds;
  }, [availableProductIds]);

  const refreshProducts = useCallback(async () => {
    if (isExpoGo || !isIOS || !connected) return;
    if (!fetchProductsPromiseRef.current) {
      fetchProductsPromiseRef.current = fetchProducts({ skus: AD_SKUS, type: 'in-app' })
        .catch((err: unknown) => {
          if (__DEV__) console.warn('[useAdIAP] fetchProducts failed:', err);
          captureBreadcrumb(
            'Ad products load failed',
            'payments.ad',
            {
              error: err instanceof Error ? err.message : 'unknown_error',
              bundle_id: IOS_BUNDLE_ID,
            },
            'warning'
          );
          setError(toUserMessage(err, 'Failed to load ad products'));
          throw err;
        })
        .finally(() => {
          fetchProductsPromiseRef.current = null;
        });
    }
    return fetchProductsPromiseRef.current;
  }, [connected, fetchProducts]);

  useEffect(() => {
    if (isExpoGo || !isIOS) return;
    if (!connected) return;
    refreshProducts().catch(() => {});
  }, [connected, refreshProducts]);

  useEffect(() => {
    if (isExpoGo || !isIOS || !connected) return;
    captureBreadcrumb('Ad products state updated', 'payments.ad', {
      available_product_ids: availableProductIds.join(','),
      missing_product_ids: AD_SKUS.filter(sku => !availableProductIds.includes(sku)).join(','),
      product_count: availableProductIds.length,
      bundle_id: IOS_BUNDLE_ID,
    });
    if (__DEV__) {
      console.log('[useAdIAP] available App Store products:', availableProductIds);
    }
  }, [availableProductIds, connected]);

  useEffect(() => {
    if (isExpoGo || !isIOS) return;
    void flushPendingAdVerifications(message => {
      setError(message);
    });
  }, []);

  const purchaseAd = useCallback(
    async (params: {
      adId: string;
      dates: string[];
      weekdayBlocks: number;
      weekendBlocks: number;
    }): Promise<{ ok: boolean; error?: string }> => {
      const { adId, dates, weekdayBlocks, weekendBlocks } = params;
      if ((weekdayBlocks <= 0 && weekendBlocks <= 0) || !isIOS) return { ok: false };
      if (!connected) {
        const errMsg =
          'Apple ad payments are unavailable because the App Store connection is not ready yet.';
        setError(errMsg);
        return { ok: false, error: errMsg };
      }

      const requiredSkus = [
        ...(weekdayBlocks > 0 ? [AD_IAP_PRODUCT_IDS.weekday] : []),
        ...(weekendBlocks > 0 ? [AD_IAP_PRODUCT_IDS.weekend] : []),
      ];
      if (!requiredSkus.every(sku => availableProductIdsRef.current.includes(sku))) {
        await refreshProducts().catch(() => {});
        const deadline = Date.now() + 3000;
        while (
          Date.now() < deadline &&
          !requiredSkus.every(sku => availableProductIdsRef.current.includes(sku))
        ) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }

      const missingSkus = requiredSkus.filter(sku => !availableProductIdsRef.current.includes(sku));
      if (missingSkus.length > 0) {
        const errMsg = 'Ad purchases are temporarily unavailable. Please try again later.';
        captureBreadcrumb(
          'Ad purchase blocked: missing store products',
          'payments.ad',
          {
            requested_product_ids: requiredSkus.join(','),
            available_product_ids: availableProductIdsRef.current.join(','),
            missing_product_ids: missingSkus.join(','),
            ad_id: adId,
            bundle_id: IOS_BUNDLE_ID,
          },
          'error'
        );
        setError(errMsg);
        return { ok: false, error: errMsg };
      }

      setPurchasing(true);
      setError(null);

      return new Promise<{ ok: boolean; error?: string }>(resolve => {
        pendingAdRef.current = {
          adId,
          dates,
          receipts: [],
          weekdayBlocks,
          weekendBlocks,
          resolve: result => {
            setPurchasing(false);
            resolve(result);
          },
        };

        const run = async () => {
          try {
            if (weekdayBlocks > 0) {
              captureBreadcrumb('Ad purchase requested', 'payments.ad', {
                ad_id: adId,
                product_id: AD_IAP_PRODUCT_IDS.weekday,
                quantity: weekdayBlocks,
              });
              await rnRequestPurchase({
                type: 'in-app',
                request: { apple: { sku: AD_IAP_PRODUCT_IDS.weekday, quantity: weekdayBlocks } },
              });
            } else if (weekendBlocks > 0) {
              captureBreadcrumb('Ad purchase requested', 'payments.ad', {
                ad_id: adId,
                product_id: AD_IAP_PRODUCT_IDS.weekend,
                quantity: weekendBlocks,
              });
              await rnRequestPurchase({
                type: 'in-app',
                request: { apple: { sku: AD_IAP_PRODUCT_IDS.weekend, quantity: weekendBlocks } },
              });
            }
          } catch (err: any) {
            if (__DEV__) console.error('[useAdIAP] requestPurchase error:', err);
            const errMsg = toUserMessage(err, 'Purchase failed');
            const p = pendingAdRef.current;
            if (p) {
              pendingAdRef.current = null;
              p.resolve({ ok: false, error: errMsg });
            }
            setPurchasing(false);
            setError(errMsg);
            resolve({ ok: false, error: errMsg });
          }
        };
        run();
      });
    },
    [connected, queueAdVerificationRecovery, refreshProducts, rnRequestPurchase]
  );

  const getProduct = useCallback(
    (type: 'weekday' | 'weekend') => {
      const sku = type === 'weekday' ? AD_IAP_PRODUCT_IDS.weekday : AD_IAP_PRODUCT_IDS.weekend;
      return (products || []).find((p: any) => (p?.id ?? p?.productId) === sku);
    },
    [products]
  );

  return { connected, products: products || [], purchasing, error, purchaseAd, getProduct };
}
