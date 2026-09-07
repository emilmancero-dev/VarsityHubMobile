-- Owner restricts schedule providers to ESPN/Yahoo. Stop advertising the
-- removed TheSportsDB connection; retain all existing event records and let
-- event-backed catalogs report SEEDED_EVENTS rather than ACTIVE_SYNCING.
UPDATE "SportsLeague" l
SET provider = NULL, provider_league_id = NULL,
    active = EXISTS (SELECT 1 FROM "Event" e WHERE e.sports_league_id = l.id),
    updated_at = now()
WHERE l.slug = 'wwe' AND l.provider = 'thesportsdb';
-- Rollback: only restore provider metadata after renewed owner authorization
-- and a tested adapter. Do not delete events or re-enable unsupported imports.
