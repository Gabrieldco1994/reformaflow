CREATE TABLE "import_ocr_usage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "attachment_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "artifact_sha256" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reserved_calls" INTEGER NOT NULL,
    "reserved_pages" INTEGER NOT NULL,
    "reserved_bytes" INTEGER NOT NULL,
    "reserved_cost_units" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "response_id" TEXT,
    "outcome" TEXT NOT NULL,
    "content_purged_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "import_ocr_usage_tenant_id_session_id_attachment_id_key"
ON "import_ocr_usage"("tenant_id", "session_id", "attachment_id");
CREATE INDEX "import_ocr_usage_day_idx" ON "import_ocr_usage"("day");
CREATE INDEX "import_ocr_usage_day_tenant_id_idx"
ON "import_ocr_usage"("day", "tenant_id");
CREATE INDEX "import_ocr_usage_day_tenant_id_actor_id_idx"
ON "import_ocr_usage"("day", "tenant_id", "actor_id");
