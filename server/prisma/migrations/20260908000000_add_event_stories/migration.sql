-- Story pages can now hang off an Event (game-less pages: pro fixtures, etc.),
-- not only a Game. Purely additive + relaxing:
--   * game_id becomes nullable (existing game stories keep their value)
--   * event_id is added with an FK to Event (ON DELETE CASCADE, matching game_id)
--   * two composite indexes mirror the per-game list + lazy-expiry access paths
-- No data is rewritten; every existing row keeps game_id set and event_id NULL.

ALTER TABLE "Story" ALTER COLUMN "game_id" DROP NOT NULL;
ALTER TABLE "Story" ADD COLUMN "event_id" TEXT;

ALTER TABLE "Story" ADD CONSTRAINT "Story_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Story_event_id_created_at_idx" ON "Story"("event_id", "created_at");
CREATE INDEX "Story_event_id_expires_at_idx" ON "Story"("event_id", "expires_at");
