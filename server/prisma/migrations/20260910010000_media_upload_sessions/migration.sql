-- Additive. Rollback: stop new clients before dropping MediaUpload and Post.client_request_hash.
ALTER TABLE "Post" ADD COLUMN "client_request_hash" TEXT;
CREATE TABLE "MediaUpload" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "expected_bytes" INTEGER NOT NULL,
  "public_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'uploading',
  "result" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "MediaUpload_public_id_key" ON "MediaUpload"("public_id");
CREATE INDEX "MediaUpload_owner_id_created_at_idx" ON "MediaUpload"("owner_id", "created_at");
CREATE INDEX "MediaUpload_state_created_at_idx" ON "MediaUpload"("state", "created_at");
