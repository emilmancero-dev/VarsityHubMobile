-- Additive only: batch media support for posts (PDF commandments, up to 5 items/post).
-- media_url stays the primary/first item for backward compat; media_urls holds
-- the full ordered list when a post has more than one media item.
ALTER TABLE "Post" ADD COLUMN "media_urls" TEXT[] NOT NULL DEFAULT '{}';
