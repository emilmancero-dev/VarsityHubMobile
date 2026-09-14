-- Raw-SQL ad-purchase tables — committed source of truth + DR schema sync.
--
-- WHY THIS FILE EXISTS
-- These five tables (AdPurchaseIntent, AdPurchaseIntentItem,
-- AdPurchaseIntentRevision, AdPurchaseReceipt, AdSlotHold) are NOT Prisma
-- models — they were created out-of-band with raw SQL on the primary and have
-- no entry in prisma/schema.prisma or prisma/migrations. Two consequences:
--   1. `prisma migrate deploy` (primary, via start.sh) never creates them, so a
--      rebuilt-from-migrations primary would be missing them.
--   2. `prisma db push` (backup replica, via start.sh) only knows Prisma models,
--      so it never creates them on the DR backup — they silently had zero DR
--      coverage (verified 2026-09-14: present+empty on primary, absent on backup).
--
-- This file is the authoritative DDL. start.sh applies it (idempotently) to BOTH
-- the primary and the DATABASE_BACKUP_URL replica on every deploy, AFTER the
-- Prisma steps, so the tables always exist on both regardless of what
-- `db push`/`migrate deploy` do or don't manage. Once present on the backup, the
-- 6-hourly db-backup-sync (RAW_SQL_BACKUP_TABLES in dbBackupTables.ts) replicates
-- their rows for DR.
--
-- Every statement is idempotent (IF NOT EXISTS). Structure captured verbatim from
-- the live primary's pg_catalog / information_schema on 2026-09-14. If you change
-- these tables on primary, update this file in the same change — it is the only
-- version-controlled definition of them.
--
-- FK order (parents first): AdPurchaseIntent -> User/Ad/TransactionLog (Prisma
-- models); AdPurchaseIntentItem, AdPurchaseIntentRevision -> AdPurchaseIntent;
-- AdPurchaseReceipt -> AdPurchaseIntentItem; AdSlotHold -> Ad. This ordering is
-- mirrored by RAW_SQL_BACKUP_TABLES so the backup sync inserts parents first.

CREATE TABLE IF NOT EXISTS "AdPurchaseIntent" (
  "id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "ad_id" text NOT NULL,
  "client_transaction_id" uuid NOT NULL,
  "dates" text[],
  "status" varchar(24) NOT NULL DEFAULT 'pending'::character varying,
  "completed_transaction_id" text,
  "last_error_code" varchar(80),
  "attempt_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL,
  CONSTRAINT "AdPurchaseIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdPurchaseIntent_bounded_dates" CHECK (((cardinality(dates) >= 1) AND (cardinality(dates) <= 56))),
  CONSTRAINT "AdPurchaseIntent_completion_ledger" CHECK ((((status)::text = 'completed'::text) = (completed_transaction_id IS NOT NULL))),
  CONSTRAINT "AdPurchaseIntent_valid_state" CHECK (((status)::text = ANY (ARRAY['pending'::text, 'needs_action'::text, 'completed'::text]))),
  CONSTRAINT "AdPurchaseIntent_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "Ad"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "AdPurchaseIntent_completed_transaction_id_fkey" FOREIGN KEY ("completed_transaction_id") REFERENCES "TransactionLog"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "AdPurchaseIntent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdPurchaseIntent_client_transaction_id_key" ON "AdPurchaseIntent" USING btree (client_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS "AdPurchaseIntent_completed_transaction_id_key" ON "AdPurchaseIntent" USING btree (completed_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS "AdPurchaseIntent_one_open_ad" ON "AdPurchaseIntent" USING btree (ad_id) WHERE ((status)::text = ANY (ARRAY['pending'::text, 'needs_action'::text]));
CREATE INDEX IF NOT EXISTS "AdPurchaseIntent_status_updated_at_idx" ON "AdPurchaseIntent" USING btree (status, updated_at);
CREATE INDEX IF NOT EXISTS "AdPurchaseIntent_user_id_status_idx" ON "AdPurchaseIntent" USING btree (user_id, status);

CREATE TABLE IF NOT EXISTS "AdPurchaseIntentItem" (
  "intent_id" uuid NOT NULL,
  "sku" varchar(40) NOT NULL,
  "quantity" integer NOT NULL,
  "unit_cents" integer NOT NULL,
  CONSTRAINT "AdPurchaseIntentItem_pkey" PRIMARY KEY ("intent_id", "sku"),
  CONSTRAINT "AdPurchaseIntentItem_valid_product" CHECK ((((sku)::text = ANY (ARRAY['MOND_THURS'::text, 'FRI_SUN'::text])) AND (quantity > 0) AND (quantity <= 9) AND (unit_cents > 0))),
  CONSTRAINT "AdPurchaseIntentItem_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "AdPurchaseIntent"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "AdPurchaseIntentRevision" (
  "id" uuid NOT NULL,
  "intent_id" uuid NOT NULL,
  "before_dates" text[] NOT NULL,
  "after_dates" text[] NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdPurchaseIntentRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdPurchaseIntentRevision_bounded_after" CHECK (((cardinality(after_dates) >= 1) AND (cardinality(after_dates) <= 56))),
  CONSTRAINT "AdPurchaseIntentRevision_bounded_before" CHECK (((cardinality(before_dates) >= 1) AND (cardinality(before_dates) <= 56))),
  CONSTRAINT "AdPurchaseIntentRevision_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "AdPurchaseIntent"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "AdPurchaseIntentRevision_intent_id_created_at_idx" ON "AdPurchaseIntentRevision" USING btree (intent_id, created_at);

CREATE TABLE IF NOT EXISTS "AdPurchaseReceipt" (
  "apple_transaction_id" varchar(100) NOT NULL,
  "intent_id" uuid NOT NULL,
  "sku" varchar(40) NOT NULL,
  "quantity" integer NOT NULL,
  "received_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdPurchaseReceipt_pkey" PRIMARY KEY ("apple_transaction_id"),
  CONSTRAINT "AdPurchaseReceipt_positive_quantity" CHECK (((quantity > 0) AND (quantity <= 9))),
  CONSTRAINT "AdPurchaseReceipt_intent_id_sku_fkey" FOREIGN KEY ("intent_id", "sku") REFERENCES "AdPurchaseIntentItem"("intent_id", "sku") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "AdPurchaseReceipt_intent_id_idx" ON "AdPurchaseReceipt" USING btree (intent_id);

CREATE TABLE IF NOT EXISTS "AdSlotHold" (
  "id" text NOT NULL,
  "ad_id" text NOT NULL,
  "date" timestamp NOT NULL,
  "purchase_reference" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdSlotHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdSlotHold_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "Ad"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdSlotHold_ad_id_date_purchase_reference_key" ON "AdSlotHold" USING btree (ad_id, date, purchase_reference);
CREATE INDEX IF NOT EXISTS "AdSlotHold_expires_at_idx" ON "AdSlotHold" USING btree (expires_at);
CREATE INDEX IF NOT EXISTS "AdSlotHold_purchase_reference_idx" ON "AdSlotHold" USING btree (purchase_reference);
