-- Let existing FK declarations continue to target the table name while SQLite
-- replaces its definition. Constraints stay enabled and are checked at commit.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS "import_observations_cleanup_orphan_artifact";
DROP TRIGGER IF EXISTS "import_session_artifacts_cleanup_orphan_artifact";
DROP TRIGGER IF EXISTS "import_artifacts_cleanup_orphan_after_storage_purge";
DROP TRIGGER IF EXISTS "import_observations_invalidate_parse_lease";
DROP TRIGGER IF EXISTS "import_observations_live_expense_claim_insert";
DROP TRIGGER IF EXISTS "import_observations_live_receipt_claim_insert";
DROP TRIGGER IF EXISTS "import_observations_live_expense_claim_update";
DROP TRIGGER IF EXISTS "import_observations_live_receipt_claim_update";
DROP TRIGGER IF EXISTS "import_observations_invalidate_live_drafts";
DROP TRIGGER IF EXISTS "expenses_dispose_import_claims_on_soft_delete";
DROP TRIGGER IF EXISTS "receipts_dispose_import_claims_on_soft_delete";
DROP TRIGGER IF EXISTS "expenses_dispose_import_claims_before_delete";
DROP TRIGGER IF EXISTS "receipts_dispose_import_claims_before_delete";

CREATE TABLE "new_import_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "document_sha256" TEXT CHECK (
      "document_sha256" IS NULL
      OR (length("document_sha256") = 64 AND "document_sha256" NOT GLOB '*[^0-9a-f]*')
    ),
    "verified_bytes" INTEGER NOT NULL CHECK (typeof("verified_bytes") = 'integer' AND "verified_bytes" BETWEEN 1 AND 10485760),
    "detected_format" TEXT NOT NULL CHECK ("detected_format" IN ('CSV','OFX','PDF','XLS','XLSX','PNG','JPEG','WEBP')),
    "state" TEXT NOT NULL CHECK ("state" IN ('RAW_READY','ANALYZING','EXTRACTED','FAILED','PURGING','PURGED')),
    "storage_key" TEXT,
    "parser_version" TEXT,
    "extraction_json" TEXT CHECK ("extraction_json" IS NULL OR json_valid("extraction_json")),
    "parse_generation" INTEGER NOT NULL DEFAULT 0 CHECK (typeof("parse_generation") = 'integer' AND "parse_generation" >= 0),
    "lease_session_id" TEXT,
    "lease_session_version" INTEGER CHECK ("lease_session_version" IS NULL OR (typeof("lease_session_version") = 'integer' AND "lease_session_version" >= 0)),
    "lease_token_expires_at" DATETIME,
    "lease_expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "import_artifacts_document_sha256_retirement_check" CHECK (
      "document_sha256" IS NOT NULL OR "state" IN ('PURGING','PURGED')
    ),
    CONSTRAINT "import_artifacts_purged_check" CHECK ("state" <> 'PURGED' OR "storage_key" IS NULL),
    CONSTRAINT "import_artifacts_tenant_id_owner_project_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id") REFERENCES "projects" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_artifacts_tenant_id_owner_project_id_lease_session_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "lease_session_id") REFERENCES "import_sessions" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

INSERT INTO "new_import_artifacts" (
  "id", "tenant_id", "owner_project_id", "document_sha256", "verified_bytes",
  "detected_format", "state", "storage_key", "parser_version", "extraction_json",
  "parse_generation", "lease_session_id", "lease_session_version",
  "lease_token_expires_at", "lease_expires_at", "created_at", "updated_at"
)
SELECT
  "id", "tenant_id", "owner_project_id",
  CASE WHEN "state" = 'PURGING' THEN NULL ELSE "document_sha256" END,
  "verified_bytes", "detected_format", "state", "storage_key",
  CASE WHEN "state" = 'PURGING' THEN NULL ELSE "parser_version" END,
  CASE WHEN "state" = 'PURGING' THEN NULL ELSE "extraction_json" END,
  "parse_generation",
  CASE WHEN "state" = 'PURGING' THEN NULL ELSE "lease_session_id" END,
  CASE WHEN "state" = 'PURGING' THEN NULL ELSE "lease_session_version" END,
  CASE WHEN "state" = 'PURGING' THEN NULL ELSE "lease_token_expires_at" END,
  CASE WHEN "state" = 'PURGING' THEN NULL ELSE "lease_expires_at" END,
  "created_at", "updated_at"
FROM "import_artifacts";

CREATE UNIQUE INDEX "new_import_artifacts_tenant_owner_id_key"
  ON "new_import_artifacts"("tenant_id", "owner_project_id", "id");

CREATE TABLE "new_import_session_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "artifact_id" TEXT,
    "position" INTEGER NOT NULL CHECK (typeof("position") = 'integer' AND "position" BETWEEN 0 AND 9),
    "file_name" TEXT NOT NULL,
    "declared_mime" TEXT NOT NULL,
    "declared_bytes" INTEGER NOT NULL CHECK (typeof("declared_bytes") = 'integer' AND "declared_bytes" BETWEEN 1 AND 10485760),
    "state" TEXT NOT NULL CHECK ("state" IN ('RESERVED','UPLOADED','ATTACHED','FAILED','RELEASED')),
    "temporary_storage_key" TEXT,
    "reserved_bytes" INTEGER NOT NULL CHECK (typeof("reserved_bytes") = 'integer' AND "reserved_bytes" BETWEEN 0 AND 10485760),
    "upload_generation" INTEGER NOT NULL DEFAULT 0 CHECK (typeof("upload_generation") = 'integer' AND "upload_generation" >= 0),
    "upload_session_version" INTEGER CHECK ("upload_session_version" IS NULL OR (typeof("upload_session_version") = 'integer' AND "upload_session_version" >= 0)),
    "upload_token_expires_at" DATETIME,
    "upload_lease_expires_at" DATETIME,
    "verified_at" DATETIME,
    "released_at" DATETIME,
    "temporary_purge_pending" BOOLEAN NOT NULL DEFAULT false CHECK ("temporary_purge_pending" IN (0,1)),
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "import_session_artifacts_attached_check" CHECK ("state" <> 'ATTACHED' OR ("artifact_id" IS NOT NULL AND "verified_at" IS NOT NULL)),
    CONSTRAINT "new_import_session_artifacts_session_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "session_id") REFERENCES "import_sessions" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "new_import_session_artifacts_artifact_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "artifact_id") REFERENCES "new_import_artifacts" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_import_session_artifacts"
SELECT * FROM "import_session_artifacts";

CREATE TABLE "new_import_observations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "evidence_json" TEXT NOT NULL CHECK (json_valid("evidence_json")),
    "claim_version" INTEGER NOT NULL DEFAULT 0 CHECK (typeof("claim_version") = 'integer' AND "claim_version" >= 0),
    "canonical_project_id" TEXT,
    "canonical_expense_id" TEXT,
    "canonical_receipt_id" TEXT,
    "canonical_index" INTEGER CHECK ("canonical_index" IS NULL OR (typeof("canonical_index") = 'integer' AND "canonical_index" BETWEEN 0 AND 2147483647)),
    "claim_session_id" TEXT,
    "claim_receipt_json" TEXT CHECK ("claim_receipt_json" IS NULL OR json_valid("claim_receipt_json")),
    "claimed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_observations_entity_check" CHECK ("canonical_expense_id" IS NULL OR "canonical_receipt_id" IS NULL),
    CONSTRAINT "import_observations_index_check" CHECK ("canonical_index" IS NULL OR "canonical_expense_id" IS NOT NULL),
    CONSTRAINT "import_observations_claim_check" CHECK (
      ("canonical_expense_id" IS NULL AND "canonical_receipt_id" IS NULL AND "canonical_project_id" IS NULL AND "canonical_index" IS NULL AND "claim_session_id" IS NULL AND "claim_receipt_json" IS NULL AND "claimed_at" IS NULL)
      OR
      (("canonical_expense_id" IS NOT NULL OR "canonical_receipt_id" IS NOT NULL) AND "canonical_project_id" IS NOT NULL AND "claim_receipt_json" IS NOT NULL AND "claimed_at" IS NOT NULL)
    ),
    CONSTRAINT "new_import_observations_artifact_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "artifact_id") REFERENCES "new_import_artifacts" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "new_import_observations_expense_fkey" FOREIGN KEY ("tenant_id", "canonical_project_id", "canonical_expense_id") REFERENCES "expenses" ("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "new_import_observations_receipt_fkey" FOREIGN KEY ("tenant_id", "canonical_project_id", "canonical_receipt_id") REFERENCES "receipts" ("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "new_import_observations_session_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "claim_session_id") REFERENCES "import_sessions" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_import_observations"
SELECT * FROM "import_observations";

DROP TABLE "import_session_artifacts";
DROP TABLE "import_observations";
DROP TABLE "import_artifacts";
ALTER TABLE "new_import_artifacts" RENAME TO "import_artifacts";
DROP INDEX "new_import_artifacts_tenant_owner_id_key";
ALTER TABLE "new_import_session_artifacts" RENAME TO "import_session_artifacts";
ALTER TABLE "new_import_observations" RENAME TO "import_observations";
CREATE UNIQUE INDEX "import_artifacts_tenant_id_owner_project_id_document_sha256_key"
  ON "import_artifacts"("tenant_id", "owner_project_id", "document_sha256");
CREATE UNIQUE INDEX "import_artifacts_tenant_id_owner_project_id_id_key"
  ON "import_artifacts"("tenant_id", "owner_project_id", "id");
CREATE UNIQUE INDEX "import_session_artifacts_session_id_position_key"
  ON "import_session_artifacts"("session_id", "position");
CREATE UNIQUE INDEX "import_session_artifacts_session_id_artifact_id_key"
  ON "import_session_artifacts"("session_id", "artifact_id");
CREATE INDEX "import_session_artifacts_tenant_id_owner_project_id_artifact_id_idx"
  ON "import_session_artifacts"("tenant_id", "owner_project_id", "artifact_id");
CREATE UNIQUE INDEX "import_observations_artifact_id_reference_key"
  ON "import_observations"("artifact_id", "reference");
CREATE INDEX "import_observations_tenant_id_canonical_project_id_canonical_expense_id_idx"
  ON "import_observations"("tenant_id", "canonical_project_id", "canonical_expense_id");
CREATE INDEX "import_observations_tenant_id_canonical_project_id_canonical_receipt_id_idx"
  ON "import_observations"("tenant_id", "canonical_project_id", "canonical_receipt_id");

CREATE TRIGGER "expenses_dispose_import_claims_on_soft_delete"
AFTER UPDATE OF "deleted_at" ON "expenses"
WHEN OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "canonical_project_id" = NEW."project_id"
    AND "canonical_expense_id" = NEW."id";
END;

CREATE TRIGGER "receipts_dispose_import_claims_on_soft_delete"
AFTER UPDATE OF "deleted_at" ON "receipts"
WHEN OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "canonical_project_id" = NEW."project_id"
    AND "canonical_receipt_id" = NEW."id";
END;

CREATE TRIGGER "expenses_dispose_import_claims_before_delete"
BEFORE DELETE ON "expenses"
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "canonical_project_id" = OLD."project_id"
    AND "canonical_expense_id" = OLD."id";
END;

CREATE TRIGGER "receipts_dispose_import_claims_before_delete"
BEFORE DELETE ON "receipts"
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "canonical_project_id" = OLD."project_id"
    AND "canonical_receipt_id" = OLD."id";
END;

CREATE TRIGGER "import_observations_live_expense_claim_insert"
BEFORE INSERT ON "import_observations"
WHEN NEW."canonical_expense_id" IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM "expenses" AS e
   WHERE e."tenant_id" = NEW."tenant_id"
     AND e."project_id" = NEW."canonical_project_id"
     AND e."id" = NEW."canonical_expense_id"
     AND e."deleted_at" IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'import observation requires a live canonical expense');
END;

CREATE TRIGGER "import_observations_live_receipt_claim_insert"
BEFORE INSERT ON "import_observations"
WHEN NEW."canonical_receipt_id" IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM "receipts" AS r
   WHERE r."tenant_id" = NEW."tenant_id"
     AND r."project_id" = NEW."canonical_project_id"
     AND r."id" = NEW."canonical_receipt_id"
     AND r."deleted_at" IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'import observation requires a live canonical receipt');
END;

CREATE TRIGGER "import_observations_live_expense_claim_update"
BEFORE UPDATE OF "tenant_id", "canonical_project_id", "canonical_expense_id"
ON "import_observations"
WHEN NEW."canonical_expense_id" IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM "expenses" AS e
   WHERE e."tenant_id" = NEW."tenant_id"
     AND e."project_id" = NEW."canonical_project_id"
     AND e."id" = NEW."canonical_expense_id"
     AND e."deleted_at" IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'import observation requires a live canonical expense');
END;

CREATE TRIGGER "import_observations_live_receipt_claim_update"
BEFORE UPDATE OF "tenant_id", "canonical_project_id", "canonical_receipt_id"
ON "import_observations"
WHEN NEW."canonical_receipt_id" IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM "receipts" AS r
   WHERE r."tenant_id" = NEW."tenant_id"
     AND r."project_id" = NEW."canonical_project_id"
     AND r."id" = NEW."canonical_receipt_id"
     AND r."deleted_at" IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'import observation requires a live canonical receipt');
END;

CREATE TRIGGER "import_observations_invalidate_parse_lease"
BEFORE DELETE ON "import_observations"
BEGIN
  UPDATE "import_artifacts"
  SET "parse_generation" = "parse_generation" + 1,
      "lease_session_id" = NULL,
      "lease_session_version" = NULL,
      "lease_token_expires_at" = NULL,
      "lease_expires_at" = NULL,
      "state" = CASE WHEN "state" = 'ANALYZING' THEN 'RAW_READY' ELSE "state" END,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "id" = OLD."artifact_id"
    AND "lease_session_id" IS NOT NULL;
END;

CREATE TRIGGER "import_observations_invalidate_live_drafts"
BEFORE DELETE ON "import_observations"
WHEN EXISTS (
  SELECT 1
  FROM "import_sessions" AS s
  WHERE s."tenant_id" = OLD."tenant_id"
    AND s."owner_project_id" = OLD."owner_project_id"
    AND s."state" IN ('DRAFT', 'ANALYZING', 'NEEDS_INPUT', 'READY', 'CONFIRMED', 'REVIEW_REQUIRED')
    AND json_valid(s."draft_json")
    AND (
      EXISTS (
        SELECT 1 FROM json_each(s."draft_json", '$.scope.observationIds') AS scope_id
        WHERE scope_id.value = OLD."id"
      )
      OR EXISTS (
        SELECT 1 FROM json_each(s."draft_json", '$.lines') AS line
        JOIN json_each(line.value, '$.observationIds') AS line_id
        WHERE line_id.value = OLD."id"
      )
      OR EXISTS (
        SELECT 1 FROM json_each(s."draft_json", '$.declarations.items') AS declaration
        WHERE json_extract(declaration.value, '$.observationId') = OLD."id"
      )
    )
)
BEGIN
  UPDATE "import_sessions"
  SET "state" = 'REVIEW_REQUIRED',
      "revision" = CASE WHEN "revision" < 2147483647 THEN "revision" + 1 ELSE "revision" END,
      "updated_at" = CURRENT_TIMESTAMP,
      "draft_json" = json_set(
        "draft_json",
        '$.scope.observationIds',
        json(COALESCE((
          SELECT json_group_array(x.value) FROM (
            SELECT scope_id.value AS value, scope_id.key AS key
            FROM json_each("import_sessions"."draft_json", '$.scope.observationIds') AS scope_id
            WHERE scope_id.value <> OLD."id" ORDER BY CAST(scope_id.key AS INTEGER)
          ) AS x
        ), '[]')),
        '$.lines',
        json(COALESCE((
          SELECT json_group_array(json(x.value)) FROM (
            SELECT json_set(line.value, '$.observationIds', json(COALESCE((
              SELECT json_group_array(y.value) FROM (
                SELECT line_id.value AS value, line_id.key AS key
                FROM json_each(line.value, '$.observationIds') AS line_id
                WHERE line_id.value <> OLD."id" ORDER BY CAST(line_id.key AS INTEGER)
              ) AS y
            ), '[]'))) AS value
            FROM json_each("import_sessions"."draft_json", '$.lines') AS line
            WHERE NOT EXISTS (
              SELECT 1 FROM json_each(line.value, '$.observationIds') AS stale_id
              WHERE stale_id.value = OLD."id"
            ) OR EXISTS (
              SELECT 1 FROM json_each(line.value, '$.observationIds') AS remaining_id
              WHERE remaining_id.value <> OLD."id"
            )
          ) AS x
        ), '[]')),
        '$.selectedLineIds',
        json(COALESCE((
          SELECT json_group_array(selected_id.value) FROM (
            SELECT selected_id.value AS value, selected_id.key AS key
            FROM json_each("import_sessions"."draft_json", '$.selectedLineIds') AS selected_id
            WHERE NOT EXISTS (
              SELECT 1 FROM json_each("import_sessions"."draft_json", '$.lines') AS line
              WHERE json_extract(line.value, '$.id') = selected_id.value
                AND EXISTS (SELECT 1 FROM json_each(line.value, '$.observationIds') AS stale_id WHERE stale_id.value = OLD."id")
                AND NOT EXISTS (SELECT 1 FROM json_each(line.value, '$.observationIds') AS remaining_id WHERE remaining_id.value <> OLD."id")
            )
            ORDER BY CAST(selected_id.key AS INTEGER)
          ) AS selected_id
        ), '[]')),
        '$.questions',
        json(COALESCE((
          SELECT json_group_array(json(json_set(q.value, '$.lineIds', json(q.line_ids))))
          FROM (
            SELECT question.value AS value, json(COALESCE((
              SELECT json_group_array(question_line.value) FROM (
                SELECT question_line.value AS value, question_line.key AS key
                FROM json_each(question.value, '$.lineIds') AS question_line
                WHERE NOT EXISTS (
                  SELECT 1 FROM json_each("import_sessions"."draft_json", '$.lines') AS line
                  WHERE json_extract(line.value, '$.id') = question_line.value
                    AND EXISTS (SELECT 1 FROM json_each(line.value, '$.observationIds') AS stale_id WHERE stale_id.value = OLD."id")
                    AND NOT EXISTS (SELECT 1 FROM json_each(line.value, '$.observationIds') AS remaining_id WHERE remaining_id.value <> OLD."id")
                )
                ORDER BY CAST(question_line.key AS INTEGER)
              ) AS question_line
            ), '[]')) AS line_ids
            FROM json_each("import_sessions"."draft_json", '$.questions') AS question
          ) AS q
          WHERE json_array_length(q.line_ids) > 0
        ), '[]')),
        '$.declarations',
        json_object('version', 1, 'items', json(COALESCE((
          SELECT json_group_array(json(declaration.value))
          FROM json_each("import_sessions"."draft_json", '$.declarations.items') AS declaration
          WHERE json_extract(declaration.value, '$.observationId') <> OLD."id"
            AND NOT EXISTS (
              SELECT 1 FROM json_each("import_sessions"."draft_json", '$.lines') AS line
              WHERE json_extract(line.value, '$.id') = json_extract(declaration.value, '$.lineId')
                AND EXISTS (SELECT 1 FROM json_each(line.value, '$.observationIds') AS stale_id WHERE stale_id.value = OLD."id")
                AND NOT EXISTS (SELECT 1 FROM json_each(line.value, '$.observationIds') AS remaining_id WHERE remaining_id.value <> OLD."id")
            )
        ), '[]')))
      ),
      "search_json" = NULL,
      "proposal_json" = NULL,
      "proposal_hash" = CASE WHEN "financial_request_id" IS NOT NULL THEN "proposal_hash" ELSE NULL END,
      "preflight_hash" = NULL,
      "challenge_json" = NULL,
      "prepare_generation" = "prepare_generation" + 1,
      "prepare_lease_json" = NULL
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "state" IN ('DRAFT', 'ANALYZING', 'NEEDS_INPUT', 'READY', 'CONFIRMED', 'REVIEW_REQUIRED')
    AND json_valid("draft_json")
    AND (
      EXISTS (SELECT 1 FROM json_each("import_sessions"."draft_json", '$.scope.observationIds') AS scope_id WHERE scope_id.value = OLD."id")
      OR EXISTS (SELECT 1 FROM json_each("import_sessions"."draft_json", '$.lines') AS line JOIN json_each(line.value, '$.observationIds') AS line_id WHERE line_id.value = OLD."id")
      OR EXISTS (SELECT 1 FROM json_each("import_sessions"."draft_json", '$.declarations.items') AS declaration WHERE json_extract(declaration.value, '$.observationId') = OLD."id")
    );
END;

CREATE TRIGGER "import_observations_finalize_unlinked_artifact"
AFTER DELETE ON "import_observations"
WHEN NOT EXISTS (
  SELECT 1 FROM "import_observations" AS o
  WHERE o."tenant_id" = OLD."tenant_id"
    AND o."owner_project_id" = OLD."owner_project_id"
    AND o."artifact_id" = OLD."artifact_id"
    AND (o."canonical_expense_id" IS NOT NULL OR o."canonical_receipt_id" IS NOT NULL)
)
 AND NOT EXISTS (
   SELECT 1 FROM "import_session_artifacts" AS r
   WHERE r."tenant_id" = OLD."tenant_id"
     AND r."owner_project_id" = OLD."owner_project_id"
     AND r."artifact_id" = OLD."artifact_id"
     AND r."state" <> 'RELEASED'
 )
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "artifact_id" = OLD."artifact_id"
    AND "canonical_expense_id" IS NULL
    AND "canonical_receipt_id" IS NULL;

  UPDATE "import_artifacts"
  SET "document_sha256" = NULL,
      "state" = CASE WHEN "storage_key" IS NULL THEN 'PURGED' ELSE 'PURGING' END,
      "parser_version" = NULL,
      "extraction_json" = NULL,
      "parse_generation" = "parse_generation" + 1,
      "lease_session_id" = NULL,
      "lease_session_version" = NULL,
      "lease_token_expires_at" = NULL,
      "lease_expires_at" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "id" = OLD."artifact_id"
    AND (
      "document_sha256" IS NOT NULL
      OR "state" NOT IN ('PURGING','PURGED')
      OR "parser_version" IS NOT NULL
      OR "extraction_json" IS NOT NULL
      OR "lease_session_id" IS NOT NULL
    );

  DELETE FROM "import_session_artifacts"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "artifact_id" = OLD."artifact_id"
    AND "state" = 'RELEASED'
    AND "temporary_storage_key" IS NULL
    AND "temporary_purge_pending" = 0;

  DELETE FROM "import_artifacts"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "id" = OLD."artifact_id"
    AND "storage_key" IS NULL
    AND "lease_session_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "import_observations" AS o
      WHERE o."artifact_id" = "import_artifacts"."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "import_session_artifacts" AS r
      WHERE r."artifact_id" = "import_artifacts"."id"
    );
END;

CREATE TRIGGER "import_session_artifacts_finalize_unlinked_artifact"
AFTER UPDATE OF "artifact_id", "state", "temporary_storage_key", "temporary_purge_pending"
ON "import_session_artifacts"
WHEN NEW."artifact_id" IS NOT NULL
 AND NEW."state" = 'RELEASED'
 AND NOT EXISTS (
   SELECT 1 FROM "import_observations" AS o
   WHERE o."tenant_id" = NEW."tenant_id"
     AND o."owner_project_id" = NEW."owner_project_id"
     AND o."artifact_id" = NEW."artifact_id"
     AND (o."canonical_expense_id" IS NOT NULL OR o."canonical_receipt_id" IS NOT NULL)
 )
 AND NOT EXISTS (
   SELECT 1 FROM "import_session_artifacts" AS r
   WHERE r."tenant_id" = NEW."tenant_id"
     AND r."owner_project_id" = NEW."owner_project_id"
     AND r."artifact_id" = NEW."artifact_id"
     AND r."state" <> 'RELEASED'
 )
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "owner_project_id" = NEW."owner_project_id"
    AND "artifact_id" = NEW."artifact_id"
    AND "canonical_expense_id" IS NULL
    AND "canonical_receipt_id" IS NULL;

  UPDATE "import_artifacts"
  SET "document_sha256" = NULL,
      "state" = CASE WHEN "storage_key" IS NULL THEN 'PURGED' ELSE 'PURGING' END,
      "parser_version" = NULL,
      "extraction_json" = NULL,
      "parse_generation" = "parse_generation" + 1,
      "lease_session_id" = NULL,
      "lease_session_version" = NULL,
      "lease_token_expires_at" = NULL,
      "lease_expires_at" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = NEW."tenant_id"
    AND "owner_project_id" = NEW."owner_project_id"
    AND "id" = NEW."artifact_id"
    AND (
      "document_sha256" IS NOT NULL
      OR "state" NOT IN ('PURGING','PURGED')
      OR "parser_version" IS NOT NULL
      OR "extraction_json" IS NOT NULL
      OR "lease_session_id" IS NOT NULL
    );

  DELETE FROM "import_session_artifacts"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "owner_project_id" = NEW."owner_project_id"
    AND "artifact_id" = NEW."artifact_id"
    AND "state" = 'RELEASED'
    AND "temporary_storage_key" IS NULL
    AND "temporary_purge_pending" = 0;

  DELETE FROM "import_artifacts"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "owner_project_id" = NEW."owner_project_id"
    AND "id" = NEW."artifact_id"
    AND "storage_key" IS NULL
    AND "lease_session_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "import_observations" AS o
      WHERE o."artifact_id" = "import_artifacts"."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "import_session_artifacts" AS r
      WHERE r."artifact_id" = "import_artifacts"."id"
    );
END;

CREATE TRIGGER "import_session_artifacts_delete_finalize_unlinked_artifact"
AFTER DELETE ON "import_session_artifacts"
WHEN OLD."artifact_id" IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM "import_observations" AS o
   WHERE o."tenant_id" = OLD."tenant_id"
     AND o."owner_project_id" = OLD."owner_project_id"
     AND o."artifact_id" = OLD."artifact_id"
     AND (o."canonical_expense_id" IS NOT NULL OR o."canonical_receipt_id" IS NOT NULL)
 )
 AND NOT EXISTS (
   SELECT 1 FROM "import_session_artifacts" AS r
   WHERE r."tenant_id" = OLD."tenant_id"
     AND r."owner_project_id" = OLD."owner_project_id"
     AND r."artifact_id" = OLD."artifact_id"
     AND r."state" <> 'RELEASED'
 )
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "artifact_id" = OLD."artifact_id"
    AND "canonical_expense_id" IS NULL
    AND "canonical_receipt_id" IS NULL;
  UPDATE "import_artifacts"
  SET "document_sha256" = NULL,
      "state" = CASE WHEN "storage_key" IS NULL THEN 'PURGED' ELSE 'PURGING' END,
      "parser_version" = NULL,
      "extraction_json" = NULL,
      "parse_generation" = "parse_generation" + 1,
      "lease_session_id" = NULL,
      "lease_session_version" = NULL,
      "lease_token_expires_at" = NULL,
      "lease_expires_at" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "id" = OLD."artifact_id"
    AND (
      "document_sha256" IS NOT NULL
      OR "state" NOT IN ('PURGING','PURGED')
      OR "parser_version" IS NOT NULL
      OR "extraction_json" IS NOT NULL
      OR "lease_session_id" IS NOT NULL
    );
  DELETE FROM "import_session_artifacts"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "artifact_id" = OLD."artifact_id"
    AND "state" = 'RELEASED'
    AND "temporary_storage_key" IS NULL
    AND "temporary_purge_pending" = 0;
  DELETE FROM "import_artifacts"
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "id" = OLD."artifact_id"
    AND "storage_key" IS NULL
    AND "lease_session_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "import_observations" AS o
      WHERE o."artifact_id" = "import_artifacts"."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "import_session_artifacts" AS r
      WHERE r."artifact_id" = "import_artifacts"."id"
    );
END;

CREATE TRIGGER "import_artifacts_finalize_unlinked_after_storage_purge"
AFTER UPDATE OF "storage_key", "lease_session_id" ON "import_artifacts"
WHEN NEW."storage_key" IS NULL
 AND NEW."lease_session_id" IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM "import_observations" AS o
   WHERE o."tenant_id" = NEW."tenant_id"
     AND o."owner_project_id" = NEW."owner_project_id"
     AND o."artifact_id" = NEW."id"
     AND (o."canonical_expense_id" IS NOT NULL OR o."canonical_receipt_id" IS NOT NULL)
 )
 AND NOT EXISTS (
   SELECT 1 FROM "import_session_artifacts" AS r
   WHERE r."tenant_id" = NEW."tenant_id"
     AND r."owner_project_id" = NEW."owner_project_id"
     AND r."artifact_id" = NEW."id"
     AND r."state" <> 'RELEASED'
 )
BEGIN
  DELETE FROM "import_observations"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "owner_project_id" = NEW."owner_project_id"
    AND "artifact_id" = NEW."id"
    AND "canonical_expense_id" IS NULL
    AND "canonical_receipt_id" IS NULL;
  DELETE FROM "import_session_artifacts"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "owner_project_id" = NEW."owner_project_id"
    AND "artifact_id" = NEW."id"
    AND "state" = 'RELEASED'
    AND "temporary_storage_key" IS NULL
    AND "temporary_purge_pending" = 0;
  DELETE FROM "import_artifacts"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "owner_project_id" = NEW."owner_project_id"
    AND "id" = NEW."id"
    AND "storage_key" IS NULL
    AND "lease_session_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "import_observations" AS o
      WHERE o."artifact_id" = "import_artifacts"."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "import_session_artifacts" AS r
      WHERE r."artifact_id" = "import_artifacts"."id"
    );
END;

-- Finalize all old artifacts without a live canonical claim or any active
-- document reference. Storage-bearing rows remain only as PURGING fences.
DELETE FROM "import_observations"
WHERE ("canonical_expense_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "expenses" AS e
        WHERE e."tenant_id" = "import_observations"."tenant_id"
          AND e."project_id" = "import_observations"."canonical_project_id"
          AND e."id" = "import_observations"."canonical_expense_id"
          AND e."deleted_at" IS NULL
      ))
   OR ("canonical_receipt_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "receipts" AS r
        WHERE r."tenant_id" = "import_observations"."tenant_id"
          AND r."project_id" = "import_observations"."canonical_project_id"
          AND r."id" = "import_observations"."canonical_receipt_id"
          AND r."deleted_at" IS NULL
      ));

DELETE FROM "import_observations"
WHERE "canonical_expense_id" IS NULL
  AND "canonical_receipt_id" IS NULL
  AND "artifact_id" IN (
    SELECT a."id"
    FROM "import_artifacts" AS a
    WHERE NOT EXISTS (
      SELECT 1 FROM "import_observations" AS o
      WHERE o."artifact_id" = a."id"
        AND (o."canonical_expense_id" IS NOT NULL OR o."canonical_receipt_id" IS NOT NULL)
    )
      AND NOT EXISTS (
        SELECT 1 FROM "import_session_artifacts" AS r
        WHERE r."tenant_id" = a."tenant_id"
          AND r."owner_project_id" = a."owner_project_id"
          AND r."artifact_id" = a."id"
          AND r."state" <> 'RELEASED'
      )
  );

UPDATE "import_artifacts"
SET "document_sha256" = NULL,
    "state" = CASE WHEN "storage_key" IS NULL THEN 'PURGED' ELSE 'PURGING' END,
    "parser_version" = NULL,
    "extraction_json" = NULL,
    "parse_generation" = "parse_generation" + 1,
    "lease_session_id" = NULL,
    "lease_session_version" = NULL,
    "lease_token_expires_at" = NULL,
    "lease_expires_at" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "import_observations" AS o
  WHERE o."tenant_id" = "import_artifacts"."tenant_id"
    AND o."owner_project_id" = "import_artifacts"."owner_project_id"
    AND o."artifact_id" = "import_artifacts"."id"
    AND (o."canonical_expense_id" IS NOT NULL OR o."canonical_receipt_id" IS NOT NULL)
)
  AND NOT EXISTS (
    SELECT 1 FROM "import_session_artifacts" AS r
    WHERE r."tenant_id" = "import_artifacts"."tenant_id"
      AND r."owner_project_id" = "import_artifacts"."owner_project_id"
      AND r."artifact_id" = "import_artifacts"."id"
      AND r."state" <> 'RELEASED'
  );

DELETE FROM "import_session_artifacts"
WHERE "state" = 'RELEASED'
  AND "temporary_storage_key" IS NULL
  AND "temporary_purge_pending" = 0
  AND NOT EXISTS (
    SELECT 1 FROM "import_observations" AS o
    WHERE o."artifact_id" = "import_session_artifacts"."artifact_id"
  )
  AND "artifact_id" IN (
    SELECT a."id" FROM "import_artifacts" AS a
    WHERE a."document_sha256" IS NULL
  );

DELETE FROM "import_artifacts"
WHERE "storage_key" IS NULL
  AND "document_sha256" IS NULL
  AND "lease_session_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "import_observations" AS o
    WHERE o."artifact_id" = "import_artifacts"."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "import_session_artifacts" AS r
    WHERE r."artifact_id" = "import_artifacts"."id"
  );
