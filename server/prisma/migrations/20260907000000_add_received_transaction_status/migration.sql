-- App Store Server Notification receipts are recorded before their side effects
-- run. `RECEIVED` must exist on every primary database before the dedup writer
-- can safely return 503 and let Apple replay a failed delivery.
ALTER TYPE "TransactionStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
