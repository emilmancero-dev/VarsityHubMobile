-- BACKUP ONLY: reviewed repair of the September 6 PostgreSQL schema drift.

-- Run in one transaction after restoring to an isolated clone first.

-- Does not mark migrations applied; the guarded snapshot sync copies history

-- only after complete schema parity. Never run against the primary database.

SET LOCAL lock_timeout = '5s';

SET LOCAL statement_timeout = '60s';

CREATE EXTENSION IF NOT EXISTS "pg_trgm" VERSION '1.6';

ALTER TYPE "NotificationType" RENAME TO "NotificationType_backup_old_20260906";

CREATE TYPE "NotificationType" AS ENUM ('FOLLOW', 'UPVOTE', 'COMMENT', 'TEAM_INVITE', 'MENTION', 'COMMENT_REPLY', 'SHARE', 'GAME_REMINDER', 'FOLLOW_REQUEST', 'MESSAGE', 'AD_REJECTED', 'JOIN_REQUEST_APPROVED', 'AD_APPROVED', 'ORG_APPROVED', 'EVENT_APPROVED', 'EVENT_REJECTED', 'COACH_REJECTED', 'TEAM_INVITE_ACCEPTED', 'TEAM_INVITE_DECLINED', 'TEAM_MEMBER_REMOVED', 'TEAM_ROLE_CHANGED', 'TEAM_FOLLOWED', 'GAME_CANCELLED', 'GAME_STORY_ADDED', 'JOIN_REQUEST_DENIED', 'COACH_APPROVED', 'ORG_REJECTED', 'TEAM_JOIN_REQUEST', 'TEAM_JOIN_APPROVED', 'TEAM_JOIN_REJECTED', 'GAME_OPPONENT_APPROVAL_REQUESTED', 'GAME_OPPONENT_APPROVED', 'GAME_OPPONENT_DECLINED');

ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType" USING "type"::text::"NotificationType";

DROP TYPE "NotificationType_backup_old_20260906";

ALTER TYPE "TransactionStatus" RENAME TO "TransactionStatus_backup_old_20260906";

CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED', 'NEEDS_REVIEW', 'RECEIVED');

ALTER TABLE "TransactionLog" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "TransactionLog" ALTER COLUMN "status" TYPE "TransactionStatus" USING "status"::text::"TransactionStatus";

ALTER TABLE "TransactionLog" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"TransactionStatus";

DROP TYPE "TransactionStatus_backup_old_20260906";

ALTER TYPE "TransactionType" RENAME TO "TransactionType_backup_old_20260906";

CREATE TYPE "TransactionType" AS ENUM ('AD_PURCHASE', 'SUBSCRIPTION_PURCHASE', 'SUBSCRIPTION_RENEWAL', 'SUBSCRIPTION_CANCEL', 'REFUND', 'PROMO_REDEMPTION', 'AD_DELETED', 'APPLE_S2S_NOTIFICATION');

ALTER TABLE "AppleTransactionClaim" ALTER COLUMN "transaction_type" TYPE "TransactionType" USING "transaction_type"::text::"TransactionType";

ALTER TABLE "TransactionLog" ALTER COLUMN "transaction_type" TYPE "TransactionType" USING "transaction_type"::text::"TransactionType";

DROP TYPE "TransactionType_backup_old_20260906";

CREATE OR REPLACE FUNCTION public.normalize_org_name_for_dedupe(input text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
  SELECT regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(replace(input, '&', 'and')),
              '\mst\.?\M', 'saint', 'g'
            ),
            '\mhs\M', 'highschool', 'g'
          ),
          '\mhigh school\M', 'highschool', 'g'
        ),
        '\mclub\M|\mleague\M|\mschool\M', '', 'g'
      ),
      '[^a-z0-9]', '', 'g'
    ),
    '\s+', '', 'g'
  );
$function$
;

CREATE INDEX IF NOT EXISTS "Event_approval_status_date_idx" ON public."Event" USING btree (approval_status, date);

CREATE INDEX IF NOT EXISTS "Event_description_trgm_idx" ON public."Event" USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Event_event_type_trgm_idx" ON public."Event" USING gin (event_type gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Event_location_trgm_idx" ON public."Event" USING gin (location gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Event_title_trgm_idx" ON public."Event" USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Game_away_team_name_trgm_idx" ON public."Game" USING gin (away_team_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Game_away_team_trgm_idx" ON public."Game" USING gin (away_team gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Game_home_team_trgm_idx" ON public."Game" USING gin (home_team gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Game_location_trgm_idx" ON public."Game" USING gin (location gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Game_title_trgm_idx" ON public."Game" USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Message_recipient_id_read_created_at_idx" ON public."Message" USING btree (recipient_id, read, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS "Organization_active_norm_name_null_zip_key" ON public."Organization" USING btree (normalize_org_name_for_dedupe((name)::text)) WHERE ((status = 'active'::"OrganizationStatus") AND (zip_code IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS "Organization_active_norm_name_zip_key" ON public."Organization" USING btree (normalize_org_name_for_dedupe((name)::text), zip_code) WHERE ((status = 'active'::"OrganizationStatus") AND (zip_code IS NOT NULL));

CREATE INDEX IF NOT EXISTS "Organization_description_trgm_idx" ON public."Organization" USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Organization_name_trgm_idx" ON public."Organization" USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Organization_sport_trgm_idx" ON public."Organization" USING gin (sport gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Organization_zip_code_status_idx" ON public."Organization" USING btree (zip_code, status);

CREATE INDEX IF NOT EXISTS "Post_media_country_upvotes_created_partial_idx" ON public."Post" USING btree (country_code, upvotes_count DESC, created_at DESC) WHERE ((deleted_at IS NULL) AND (media_url IS NOT NULL));

CREATE INDEX IF NOT EXISTS "Team_city_trgm_idx" ON public."Team" USING gin (city gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Team_league_trgm_idx" ON public."Team" USING gin (league gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Team_name_trgm_idx" ON public."Team" USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Team_sport_trgm_idx" ON public."Team" USING gin (sport gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Team_state_trgm_idx" ON public."Team" USING gin (state gin_trgm_ops);

DROP INDEX "TransactionLog_apple_transaction_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "TransactionLog_apple_transaction_id_key" ON public."TransactionLog" USING btree (apple_transaction_id) WHERE (apple_transaction_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "TransactionLog_google_order_id_key" ON public."TransactionLog" USING btree (order_id) WHERE (order_id ~~ 'google_purchase:%'::text);

CREATE INDEX IF NOT EXISTS "User_display_name_trgm_idx" ON public."User" USING gin (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "User_parental_consent_requested_at_idx" ON public."User" USING btree (parental_consent_requested_at) WHERE (parental_consent_requested_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS "User_parental_consent_token_hash_idx" ON public."User" USING btree (parental_consent_token_hash) WHERE (parental_consent_token_hash IS NOT NULL);

CREATE INDEX IF NOT EXISTS "User_payment_pending_idx" ON public."User" USING btree (payment_pending);

CREATE INDEX IF NOT EXISTS "User_pending_plan_idx" ON public."User" USING btree (pending_plan);

CREATE INDEX IF NOT EXISTS "User_plan_idx" ON public."User" USING btree (plan);

CREATE INDEX IF NOT EXISTS "User_profile_private_idx" ON public."User" USING btree (profile_private);

CREATE INDEX IF NOT EXISTS "User_username_trgm_idx" ON public."User" USING gin (username gin_trgm_ops);

DROP POLICY IF EXISTS "group_chat_member_owner_access" ON "GroupChatMember";

CREATE POLICY "group_chat_member_owner_access" ON "GroupChatMember" AS PERMISSIVE FOR ALL TO public USING ((user_id = current_setting('app.current_user_id'::text, true))) WITH CHECK ((user_id = current_setting('app.current_user_id'::text, true)));

DROP POLICY IF EXISTS "message_participant_access" ON "Message";

CREATE POLICY "message_participant_access" ON "Message" AS PERMISSIVE FOR ALL TO public USING (((sender_id = current_setting('app.current_user_id'::text, true)) OR (recipient_id = current_setting('app.current_user_id'::text, true)))) WITH CHECK ((sender_id = current_setting('app.current_user_id'::text, true)));

DROP POLICY IF EXISTS "org_membership_owner_access" ON "OrganizationMembership";

CREATE POLICY "org_membership_owner_access" ON "OrganizationMembership" AS PERMISSIVE FOR ALL TO public USING ((user_id = current_setting('app.current_user_id'::text, true))) WITH CHECK ((user_id = current_setting('app.current_user_id'::text, true)));

DROP POLICY IF EXISTS "team_membership_owner_access" ON "TeamMembership";

CREATE POLICY "team_membership_owner_access" ON "TeamMembership" AS PERMISSIVE FOR ALL TO public USING ((user_id = current_setting('app.current_user_id'::text, true))) WITH CHECK ((user_id = current_setting('app.current_user_id'::text, true)));

ALTER TABLE "GroupChatMember" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "GroupChatMember" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "Message" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "OrganizationMembership" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "OrganizationMembership" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "TeamMembership" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "TeamMembership" NO FORCE ROW LEVEL SECURITY;
