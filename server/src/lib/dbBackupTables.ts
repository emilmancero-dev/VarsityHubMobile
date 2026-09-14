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

// Primary-DB tables that are INTENTIONALLY not replicated to the DR backup.
// The sync alarms on any public table missing from TABLES_IN_ORDER (live schema
// drift guard). These are deliberately absent — excluded from that alarm so the
// signal stays meaningful:
//   - PushTicket: ephemeral Expo push-delivery receipts (expire ~24h), created
//     out-of-band (not a Prisma model, no schema.prisma entry), worthless to
//     restore. Never referenced by a backed-up table, so no CASCADE risk.
//   - AdPurchaseIntent / AdPurchaseIntentItem / AdPurchaseIntentRevision /
//     AdPurchaseReceipt / AdSlotHold: a newer ad-purchase flow's raw-SQL tables
//     (NOT Prisma models). Verified 2026-09-14: all 5 are empty on primary AND
//     do not yet exist on the backup replica (which never receives
//     `prisma migrate deploy`). Forcing them into the sync would fail every
//     INSERT against a missing backup table and flip the whole sync to "failed",
//     so they are excluded for now to keep the drift alarm meaningful.
//     FOLLOW-UP (before this flow ships with real financial data): create these
//     tables on the backup replica, then move them into a parents-first backup
//     list so AdPurchaseReceipt/Intent history is covered by DR. FK order
//     (from live information_schema): AdPurchaseIntent -> User/Ad/TransactionLog;
//     AdPurchaseIntentItem, AdPurchaseIntentRevision -> AdPurchaseIntent;
//     AdPurchaseReceipt -> AdPurchaseIntentItem; AdSlotHold -> Ad.
export const BACKUP_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  'PushTicket',
  'AdPurchaseIntent',
  'AdPurchaseIntentItem',
  'AdPurchaseIntentRevision',
  'AdPurchaseReceipt',
  'AdSlotHold',
]);
