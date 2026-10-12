-- Maria's import observations are only dedupe/linkage claims while their
-- canonical financial record is live. Preserve the financial row and dispose
-- only the dependent coordination claim at the first tombstone transition.

CREATE TEMP TABLE "canonical_import_dead_observations" AS
SELECT o."id"
FROM "import_observations" AS o
WHERE (o."canonical_expense_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "expenses" AS e
        WHERE e."tenant_id" = o."tenant_id"
          AND e."project_id" = o."canonical_project_id"
          AND e."id" = o."canonical_expense_id"
          AND e."deleted_at" IS NULL
      ))
   OR (o."canonical_receipt_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "receipts" AS r
        WHERE r."tenant_id" = o."tenant_id"
          AND r."project_id" = o."canonical_project_id"
          AND r."id" = o."canonical_receipt_id"
          AND r."deleted_at" IS NULL
      ));

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
        SELECT 1
        FROM json_each(s."draft_json", '$.scope.observationIds') AS scope_id
        WHERE scope_id.value = OLD."id"
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(s."draft_json", '$.lines') AS line
        JOIN json_each(line.value, '$.observationIds') AS line_id
        WHERE line_id.value = OLD."id"
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(s."draft_json", '$.declarations.items') AS declaration
        WHERE json_extract(declaration.value, '$.observationId') = OLD."id"
      )
    )
)
BEGIN
  UPDATE "import_sessions"
  SET "state" = 'REVIEW_REQUIRED',
      "revision" = CASE
        WHEN "revision" < 2147483647 THEN "revision" + 1
        ELSE "revision"
      END,
      "updated_at" = CURRENT_TIMESTAMP,
      "draft_json" = json_set(
        "draft_json",
        '$.scope.observationIds',
        json(COALESCE((
          SELECT json_group_array(scope_id.value)
          FROM (
            SELECT scope_id.value AS value, scope_id.key AS key
            FROM json_each("import_sessions"."draft_json", '$.scope.observationIds') AS scope_id
            WHERE scope_id.value <> OLD."id"
            ORDER BY CAST(scope_id.key AS INTEGER)
          ) AS scope_id
        ), '[]')),
        '$.lines',
        json(COALESCE((
          SELECT json_group_array(json(clean_line.value))
          FROM (
            SELECT json_set(
              line.value,
              '$.observationIds',
              json(COALESCE((
                SELECT json_group_array(clean_id.value)
                FROM (
                  SELECT line_id.value AS value, line_id.key AS key
                  FROM json_each(line.value, '$.observationIds') AS line_id
                  WHERE line_id.value <> OLD."id"
                  ORDER BY CAST(line_id.key AS INTEGER)
                ) AS clean_id
              ), '[]'))
            ) AS value
            FROM json_each("import_sessions"."draft_json", '$.lines') AS line
            WHERE NOT EXISTS (
              SELECT 1
              FROM json_each(line.value, '$.observationIds') AS stale_id
              WHERE stale_id.value = OLD."id"
            )
            OR EXISTS (
              SELECT 1
              FROM json_each(line.value, '$.observationIds') AS remaining_id
              WHERE remaining_id.value <> OLD."id"
            )
          ) AS clean_line
        ), '[]')),
        '$.selectedLineIds',
        json(COALESCE((
          SELECT json_group_array(selected_id.value)
          FROM (
            SELECT selected_id.value AS value, selected_id.key AS key
            FROM json_each("import_sessions"."draft_json", '$.selectedLineIds') AS selected_id
            WHERE NOT EXISTS (
              SELECT 1
              FROM json_each("import_sessions"."draft_json", '$.lines') AS line
              WHERE json_extract(line.value, '$.id') = selected_id.value
                AND EXISTS (
                  SELECT 1 FROM json_each(line.value, '$.observationIds') AS stale_id
                  WHERE stale_id.value = OLD."id"
                )
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(line.value, '$.observationIds') AS remaining_id
                  WHERE remaining_id.value <> OLD."id"
                )
            )
            ORDER BY CAST(selected_id.key AS INTEGER)
          ) AS selected_id
        ), '[]')),
        '$.questions',
        json(COALESCE((
          SELECT json_group_array(json(json_set(question.value, '$.lineIds', json(question.line_ids))))
          FROM (
            SELECT q.value AS value,
              json(COALESCE((
                SELECT json_group_array(question_line.value)
                FROM (
                  SELECT question_line.value AS value, question_line.key AS key
                  FROM json_each(q.value, '$.lineIds') AS question_line
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM json_each("import_sessions"."draft_json", '$.lines') AS line
                    WHERE json_extract(line.value, '$.id') = question_line.value
                      AND EXISTS (
                        SELECT 1 FROM json_each(line.value, '$.observationIds') AS stale_id
                        WHERE stale_id.value = OLD."id"
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM json_each(line.value, '$.observationIds') AS remaining_id
                        WHERE remaining_id.value <> OLD."id"
                      )
                  )
                  ORDER BY CAST(question_line.key AS INTEGER)
                ) AS question_line
              ), '[]')) AS line_ids
            FROM json_each("import_sessions"."draft_json", '$.questions') AS q
          ) AS question
          WHERE json_array_length(question.line_ids) > 0
        ), '[]')),
        '$.declarations',
        json_object(
          'version', 1,
          'items', json(COALESCE((
            SELECT json_group_array(json(declaration.value))
            FROM json_each("import_sessions"."draft_json", '$.declarations.items') AS declaration
            WHERE json_extract(declaration.value, '$.observationId') <> OLD."id"
              AND NOT EXISTS (
                SELECT 1
                FROM json_each("import_sessions"."draft_json", '$.lines') AS line
                WHERE json_extract(line.value, '$.id') = json_extract(declaration.value, '$.lineId')
                  AND EXISTS (
                    SELECT 1 FROM json_each(line.value, '$.observationIds') AS stale_id
                    WHERE stale_id.value = OLD."id"
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(line.value, '$.observationIds') AS remaining_id
                    WHERE remaining_id.value <> OLD."id"
                  )
              )
          ), '[]'))
        )
      ),
      "search_json" = NULL,
      "proposal_json" = NULL,
      "proposal_hash" = CASE
        WHEN "financial_request_id" IS NOT NULL THEN "proposal_hash"
        ELSE NULL
      END,
      "preflight_hash" = NULL,
      "challenge_json" = NULL,
      "prepare_generation" = "prepare_generation" + 1,
      "prepare_lease_json" = NULL
  WHERE "tenant_id" = OLD."tenant_id"
    AND "owner_project_id" = OLD."owner_project_id"
    AND "state" IN ('DRAFT', 'ANALYZING', 'NEEDS_INPUT', 'READY', 'CONFIRMED', 'REVIEW_REQUIRED')
    AND json_valid("draft_json")
    AND (
      EXISTS (
        SELECT 1
        FROM json_each("import_sessions"."draft_json", '$.scope.observationIds') AS scope_id
        WHERE scope_id.value = OLD."id"
      )
      OR EXISTS (
        SELECT 1
        FROM json_each("import_sessions"."draft_json", '$.lines') AS line
        JOIN json_each(line.value, '$.observationIds') AS line_id
        WHERE line_id.value = OLD."id"
      )
      OR EXISTS (
        SELECT 1
        FROM json_each("import_sessions"."draft_json", '$.declarations.items') AS declaration
        WHERE json_extract(declaration.value, '$.observationId') = OLD."id"
      )
    );
END;

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

-- A released attachment is documentary coordination, not an enduring hash
-- identity. Retain it while any canonical evidence, live reference, staged
-- temporary object, or storage key still needs it; otherwise remove the
-- released association and artifact only after storage fencing has completed.
CREATE TRIGGER "import_observations_cleanup_orphan_artifact"
AFTER DELETE ON "import_observations"
WHEN NOT EXISTS (
  SELECT 1 FROM "import_observations" AS o WHERE o."artifact_id" = OLD."artifact_id"
)
 AND EXISTS (
  SELECT 1 FROM "import_artifacts" AS a
  WHERE a."id" = OLD."artifact_id"
    AND a."tenant_id" = OLD."tenant_id"
    AND a."owner_project_id" = OLD."owner_project_id"
    AND a."storage_key" IS NULL
    AND a."lease_session_id" IS NULL
 )
 AND NOT EXISTS (
   SELECT 1 FROM "import_session_artifacts" AS r
   WHERE r."tenant_id" = OLD."tenant_id"
     AND r."owner_project_id" = OLD."owner_project_id"
     AND r."artifact_id" = OLD."artifact_id"
     AND (r."state" <> 'RELEASED' OR r."temporary_storage_key" IS NOT NULL OR r."temporary_purge_pending" = 1)
 )
BEGIN
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

CREATE TRIGGER "import_session_artifacts_cleanup_orphan_artifact"
AFTER UPDATE OF "artifact_id", "state", "temporary_storage_key", "temporary_purge_pending"
ON "import_session_artifacts"
WHEN NEW."artifact_id" IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM "import_observations" AS o WHERE o."artifact_id" = NEW."artifact_id"
 )
 AND EXISTS (
   SELECT 1 FROM "import_artifacts" AS a
   WHERE a."id" = NEW."artifact_id"
     AND a."tenant_id" = NEW."tenant_id"
     AND a."owner_project_id" = NEW."owner_project_id"
     AND a."storage_key" IS NULL
     AND a."lease_session_id" IS NULL
 )
 AND NOT EXISTS (
   SELECT 1 FROM "import_session_artifacts" AS r
   WHERE r."tenant_id" = NEW."tenant_id"
     AND r."owner_project_id" = NEW."owner_project_id"
     AND r."artifact_id" = NEW."artifact_id"
     AND (r."state" <> 'RELEASED' OR r."temporary_storage_key" IS NOT NULL OR r."temporary_purge_pending" = 1)
 )
BEGIN
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

CREATE TRIGGER "import_artifacts_cleanup_orphan_after_storage_purge"
AFTER UPDATE OF "storage_key", "lease_session_id" ON "import_artifacts"
WHEN NEW."storage_key" IS NULL
 AND NEW."lease_session_id" IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM "import_observations" AS o WHERE o."artifact_id" = NEW."id"
 )
 AND NOT EXISTS (
   SELECT 1 FROM "import_session_artifacts" AS r
   WHERE r."tenant_id" = NEW."tenant_id"
     AND r."owner_project_id" = NEW."owner_project_id"
     AND r."artifact_id" = NEW."id"
     AND (r."state" <> 'RELEASED' OR r."temporary_storage_key" IS NOT NULL OR r."temporary_purge_pending" = 1)
 )
BEGIN
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

-- Repair legacy dead claims after the normal cleanup triggers are active.
DELETE FROM "import_observations"
WHERE "id" IN (SELECT "id" FROM "canonical_import_dead_observations");
DROP TABLE "canonical_import_dead_observations";
