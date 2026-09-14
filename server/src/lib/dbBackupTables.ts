/**
 * Table sync order + cycle-breaking column config for the DB backup sync.
 *
 * Kept in a pure, DB-free module (like dbBackupSql.ts) so
 * db-backup-table-order.test.ts can verify it against prisma/schema.prisma
 * without a database connection. That test enforces:
 *   - every Prisma model appears here exactly once
 *   - every FK parent is listed strictly before its children
 *   - every DEFERRED_FK_COLUMNS entry is a real, nullable FK column
 */

// Tables in dependency order (parents strictly before children). The old
// order listed Post before Game/Event and Notification before Message, and
// omitted five models entirely — see db-backup-table-order.test.ts.
export const TABLES_IN_ORDER = [
  // No FK dependencies
  'Category',
  'PromoCode',
  'ProcessedStripeEvent',
  'AdminActivityLog',
  'AppleTransactionClaim',
  'MediaUpload',
  // User <-> Organization cycle: User.organization_id is deferred, so User
  // can lead and Organization only needs User.
  'User',
  'Organization',
  'SportProgram',
  'Team',
  'Game',
  'SportsLeague',
  'SportsSeason', // needs SportsLeague
  'SportsIngestRun', // needs SportsLeague when league-scoped
  'ProTeam', // no FK deps; must precede Event (pro_home_team_id / pro_away_team_id)
  'Event', // needs SportsLeague + ProTeam when external schedule-backed
  'Post',
  'Ad',
  'Message',
  'GroupChat',
  'Comment', // parent_id (self-FK) is deferred
  'Poll',
  'PollOption',
  'PollVote',
  'Story',
  'GameVote',
  'EventVote',
  'PostUpvote',
  'PostBookmark',
  'CategoryAssignment',
  'CategoryFollow',
  'EventRsvp',
  'EventPostingUnlock', // needs User + Event
  'EventDesignatedPoster', // needs User + Event

  'AdReservation',
  'GroupChatMember',
  'GroupChatMessage',
  'Notification', // needs User, Post, Comment, Message
  'Follows',
  'BlockedUser',
  'TeamMembership',
  'TeamFollow',
  'ProgramFollow',
  'ProTeamFollow', // needs User + ProTeam
  'TeamInvite',
  'TeamJoinRequest',
  'OrganizationMembership',
  'OrganizationFollow',
  'OrganizationInvite',
  'OrganizationJoinRequest',
  'CoachApplication',
  'DataExport',
  'ParentalConsentAudit',
  'RefreshToken',
  'PromoRedemption',
  'TransactionLog',
  'AbuseReport',
  'UserWarning',
];

// FK columns excluded from the main INSERT pass and back-filled with UPDATEs
// after every table is inserted. These break the two FK shapes a single
// parents-first insert order cannot satisfy:
//   - User.organization_id <-> Organization.league_owner_id (cycle)
//   - Comment.parent_id (self-referential replies)
// Every column listed here must be nullable — the main pass inserts NULL.
export const DEFERRED_FK_COLUMNS: Record<string, string[]> = {
  User: ['organization_id'],
  Comment: ['parent_id'],
};

// Raw-SQL tables (NOT Prisma models) that ARE replicated to the DR backup.
//
// These five belong to the ad-purchase flow and were created out-of-band with
// raw SQL on the primary — they have no entry in prisma/schema.prisma or
// prisma/migrations, so they cannot go in TABLES_IN_ORDER (the order test
// enforces a strict Prisma-model bijection). Their authoritative DDL lives in
// prisma/raw-sql/ad-purchase-tables.sql, which start.sh applies (idempotently)
// to BOTH primary and the backup replica on every deploy — the backup's
// `prisma db push` only knows Prisma models and, worse, actively DROPS these
// non-Prisma tables with --accept-data-loss (verified 2026-09-14), so the raw
// DDL step MUST run after db push and does.
//
// Listed here in parents-first order (mirrors the SQL file and the FK graph
// verified from live information_schema):
//   AdPurchaseIntent      -> User / Ad / TransactionLog (Prisma models)
//   AdPurchaseIntentItem  -> AdPurchaseIntent
//   AdPurchaseIntentRevision -> AdPurchaseIntent
//   AdPurchaseReceipt     -> AdPurchaseIntentItem (composite FK intent_id, sku)
//   AdSlotHold            -> Ad
// The backup sync appends this list after TABLES_IN_ORDER, so their Prisma
// parents (User/Ad/TransactionLog) are always inserted first, and it is folded
// into the "unlisted table" drift filter so these no longer false-alarm.
export const RAW_SQL_BACKUP_TABLES = [
  'AdPurchaseIntent',
  'AdPurchaseIntentItem',
  'AdPurchaseIntentRevision',
  'AdPurchaseReceipt',
  'AdSlotHold',
] as const;

// Primary-DB tables that are INTENTIONALLY not replicated to the DR backup.
// The sync alarms on any public table missing from the backup set (live schema
// drift guard). These are deliberately absent — excluded from that alarm so the
// signal stays meaningful:
//   - PushTicket: ephemeral Expo push-delivery receipts (expire ~24h), created
//     out-of-band (not a Prisma model, no schema.prisma entry), worthless to
//     restore. Never referenced by a backed-up table, so no CASCADE risk.
export const BACKUP_EXCLUDED_TABLES: ReadonlySet<string> = new Set(['PushTicket']);
