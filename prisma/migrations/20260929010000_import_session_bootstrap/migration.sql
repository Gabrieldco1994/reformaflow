-- Additive coordination only: no financial backfill, table rebuild or legacy drift repair.
-- Tables/relations/indexes correspond to schema.prisma; Prisma 5 cannot express CHECKs.
-- Application rollback keeps these tables. Physical rollback requires empty tables or a
-- separately verified archival backup; never discard financial claims/receipts on rollback.

CREATE UNIQUE INDEX "users_tenant_id_id_key" ON "users"("tenant_id", "id");
CREATE UNIQUE INDEX "projects_tenant_id_id_key" ON "projects"("tenant_id", "id");
CREATE UNIQUE INDEX "credit_cards_tenant_id_project_id_id_key" ON "credit_cards"("tenant_id", "project_id", "id");
CREATE UNIQUE INDEX "expenses_tenant_id_project_id_id_key" ON "expenses"("tenant_id", "project_id", "id");
CREATE UNIQUE INDEX "receipts_tenant_id_project_id_id_key" ON "receipts"("tenant_id", "project_id", "id");

CREATE TABLE "import_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "protocol_version" INTEGER NOT NULL DEFAULT 1 CHECK ("protocol_version" = 1),
    "kind" TEXT NOT NULL CHECK ("kind" = 'CREATE_CARD_PURCHASES'),
    "state" TEXT NOT NULL CHECK ("state" IN ('DRAFT','ANALYZING','NEEDS_INPUT','READY','CONFIRMED','APPLIED','REVIEW_REQUIRED','CANCELLED','EXPIRED')),
    "revision" INTEGER NOT NULL CHECK (typeof("revision") = 'integer' AND "revision" BETWEEN 1 AND 2147483647),
    "create_request_id" TEXT NOT NULL,
    "create_payload_hash" TEXT NOT NULL CHECK (length("create_payload_hash") = 64 AND "create_payload_hash" NOT GLOB '*[^0-9a-f]*'),
    "consent_policy_version" INTEGER NOT NULL CHECK ("consent_policy_version" = 1),
    "consented_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "last_user_edit_at" DATETIME NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "draft_json" TEXT NOT NULL CHECK (json_valid("draft_json")),
    "search_json" TEXT CHECK ("search_json" IS NULL OR json_valid("search_json")),
    "proposal_json" TEXT CHECK ("proposal_json" IS NULL OR json_valid("proposal_json")),
    "proposal_hash" TEXT CHECK ("proposal_hash" IS NULL OR (length("proposal_hash") = 64 AND "proposal_hash" NOT GLOB '*[^0-9a-f]*')),
    "preflight_hash" TEXT CHECK ("preflight_hash" IS NULL OR (length("preflight_hash") = 64 AND "preflight_hash" NOT GLOB '*[^0-9a-f]*')),
    "challenge_json" TEXT CHECK ("challenge_json" IS NULL OR json_valid("challenge_json")),
    "prepare_generation" INTEGER NOT NULL DEFAULT 0 CHECK (typeof("prepare_generation") = 'integer' AND "prepare_generation" >= 0),
    "prepare_lease_json" TEXT CHECK ("prepare_lease_json" IS NULL OR json_valid("prepare_lease_json")),
    "financial_request_id" TEXT,
    "confirmed_revision" INTEGER CHECK ("confirmed_revision" IS NULL OR (typeof("confirmed_revision") = 'integer' AND "confirmed_revision" BETWEEN 1 AND 2147483647)),
    "confirmed_session_version" INTEGER CHECK ("confirmed_session_version" IS NULL OR (typeof("confirmed_session_version") = 'integer' AND "confirmed_session_version" >= 0)),
    "confirmed_at" DATETIME,
    "receipt_json" TEXT CHECK ("receipt_json" IS NULL OR json_valid("receipt_json")),
    "closed_at" DATETIME,
    CONSTRAINT "import_sessions_confirmation_tuple_check" CHECK (
      ("financial_request_id" IS NULL AND "confirmed_revision" IS NULL AND "confirmed_session_version" IS NULL AND "confirmed_at" IS NULL)
      OR
      ("financial_request_id" IS NOT NULL AND "confirmed_revision" IS NOT NULL AND "confirmed_session_version" IS NOT NULL AND "confirmed_at" IS NOT NULL AND "proposal_hash" IS NOT NULL)
    ),
    CONSTRAINT "import_sessions_applied_check" CHECK (
      "state" <> 'APPLIED' OR ("receipt_json" IS NOT NULL AND "financial_request_id" IS NOT NULL AND "closed_at" IS NOT NULL)
    ),
    CONSTRAINT "import_sessions_tenant_id_owner_user_id_fkey" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "users" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_sessions_tenant_id_owner_project_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id") REFERENCES "projects" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_sessions_tenant_id_owner_project_id_card_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "card_id") REFERENCES "credit_cards" ("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "import_sessions_tenant_id_owner_user_id_create_request_id_key" ON "import_sessions"("tenant_id", "owner_user_id", "create_request_id");
CREATE UNIQUE INDEX "import_sessions_tenant_id_owner_user_id_financial_request_id_key" ON "import_sessions"("tenant_id", "owner_user_id", "financial_request_id");
CREATE UNIQUE INDEX "import_sessions_tenant_id_owner_project_id_id_key" ON "import_sessions"("tenant_id", "owner_project_id", "id");
CREATE INDEX "import_sessions_state_expires_at_idx" ON "import_sessions"("state", "expires_at");

CREATE TABLE "import_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "document_sha256" TEXT NOT NULL CHECK (length("document_sha256") = 64 AND "document_sha256" NOT GLOB '*[^0-9a-f]*'),
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
    CONSTRAINT "import_artifacts_purged_check" CHECK ("state" <> 'PURGED' OR "storage_key" IS NULL),
    CONSTRAINT "import_artifacts_tenant_id_owner_project_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id") REFERENCES "projects" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_artifacts_tenant_id_owner_project_id_lease_session_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "lease_session_id") REFERENCES "import_sessions" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "import_artifacts_tenant_id_owner_project_id_document_sha256_key" ON "import_artifacts"("tenant_id", "owner_project_id", "document_sha256");
CREATE UNIQUE INDEX "import_artifacts_tenant_id_owner_project_id_id_key" ON "import_artifacts"("tenant_id", "owner_project_id", "id");

CREATE TABLE "import_session_artifacts" (
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
    CONSTRAINT "import_session_artifacts_tenant_id_owner_project_id_session_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "session_id") REFERENCES "import_sessions" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_session_artifacts_tenant_id_owner_project_id_artifact_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "artifact_id") REFERENCES "import_artifacts" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "import_session_artifacts_session_id_position_key" ON "import_session_artifacts"("session_id", "position");
CREATE UNIQUE INDEX "import_session_artifacts_session_id_artifact_id_key" ON "import_session_artifacts"("session_id", "artifact_id");
CREATE INDEX "import_session_artifacts_tenant_id_owner_project_id_artifact_id_idx" ON "import_session_artifacts"("tenant_id", "owner_project_id", "artifact_id");

CREATE TABLE "import_observations" (
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
    CONSTRAINT "import_observations_tenant_id_owner_project_id_artifact_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "artifact_id") REFERENCES "import_artifacts" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_observations_tenant_id_canonical_project_id_canonical_expense_id_fkey" FOREIGN KEY ("tenant_id", "canonical_project_id", "canonical_expense_id") REFERENCES "expenses" ("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_observations_tenant_id_canonical_project_id_canonical_receipt_id_fkey" FOREIGN KEY ("tenant_id", "canonical_project_id", "canonical_receipt_id") REFERENCES "receipts" ("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "import_observations_tenant_id_owner_project_id_claim_session_id_fkey" FOREIGN KEY ("tenant_id", "owner_project_id", "claim_session_id") REFERENCES "import_sessions" ("tenant_id", "owner_project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "import_observations_artifact_id_reference_key" ON "import_observations"("artifact_id", "reference");
CREATE INDEX "import_observations_tenant_id_canonical_project_id_canonical_expense_id_idx" ON "import_observations"("tenant_id", "canonical_project_id", "canonical_expense_id");
CREATE INDEX "import_observations_tenant_id_canonical_project_id_canonical_receipt_id_idx" ON "import_observations"("tenant_id", "canonical_project_id", "canonical_receipt_id");
