-- Rebuild only the OCR usage ledger. Foreign-key enforcement remains enabled:
-- invalid legacy rows abort the copy instead of being repaired or discarded.
CREATE UNIQUE INDEX "import_session_artifacts_tenant_id_owner_project_id_session_id_id_key"
ON "import_session_artifacts"("tenant_id", "owner_project_id", "session_id", "id");

CREATE TABLE "new_import_ocr_usage" (
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
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "import_ocr_usage_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_ocr_usage_session_fkey"
      FOREIGN KEY ("tenant_id", "owner_project_id", "session_id")
      REFERENCES "import_sessions" ("tenant_id", "owner_project_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_ocr_usage_attachment_fkey"
      FOREIGN KEY ("tenant_id", "owner_project_id", "session_id", "attachment_id")
      REFERENCES "import_session_artifacts" ("tenant_id", "owner_project_id", "session_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_ocr_usage_artifact_fkey"
      FOREIGN KEY ("tenant_id", "owner_project_id", "artifact_id")
      REFERENCES "import_artifacts" ("tenant_id", "owner_project_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

INSERT INTO "new_import_ocr_usage" (
    "id", "day", "tenant_id", "owner_project_id", "actor_id", "session_id",
    "attachment_id", "artifact_id", "artifact_sha256", "request_id",
    "provider", "model", "reserved_calls", "reserved_pages", "reserved_bytes",
    "reserved_cost_units", "input_tokens", "output_tokens", "total_tokens",
    "response_id", "outcome", "content_purged_at", "created_at", "updated_at"
)
SELECT
    "id", "day", "tenant_id", "owner_project_id", "actor_id", "session_id",
    "attachment_id", "artifact_id", "artifact_sha256", "request_id",
    "provider", "model", "reserved_calls", "reserved_pages", "reserved_bytes",
    "reserved_cost_units", "input_tokens", "output_tokens", "total_tokens",
    "response_id", "outcome", "content_purged_at", "created_at", "updated_at"
FROM "import_ocr_usage";

DROP TABLE "import_ocr_usage";
ALTER TABLE "new_import_ocr_usage" RENAME TO "import_ocr_usage";

CREATE UNIQUE INDEX "import_ocr_usage_tenant_id_session_id_attachment_id_key"
ON "import_ocr_usage"("tenant_id", "session_id", "attachment_id");
CREATE INDEX "import_ocr_usage_day_idx" ON "import_ocr_usage"("day");
CREATE INDEX "import_ocr_usage_day_tenant_id_idx"
ON "import_ocr_usage"("day", "tenant_id");
CREATE INDEX "import_ocr_usage_day_tenant_id_actor_id_idx"
ON "import_ocr_usage"("day", "tenant_id", "actor_id");
