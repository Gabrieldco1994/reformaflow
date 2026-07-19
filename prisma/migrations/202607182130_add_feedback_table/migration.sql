-- ponytail: create feedback table in prod via migrate deploy
CREATE TABLE IF NOT EXISTS "feedbacks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "feedbacks_tenant_id_idx" ON "feedbacks"("tenant_id");
