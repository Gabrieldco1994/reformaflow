-- Additive only: existing financial rows, stamps and partial indexes stay intact.
CREATE TABLE "invoice_reconciliation_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_expense_id" TEXT NOT NULL,
    "source_index" INTEGER NOT NULL,
    "source_cash_flow_entry_id" TEXT,
    "bank_statement_import_id" TEXT,
    "card_statement_import_id" TEXT,
    "account_id" TEXT,
    "origin_card_id" TEXT,
    "destination_card_id" TEXT NOT NULL,
    "invoice_due_month" TEXT NOT NULL,
    "capacity_cents" INTEGER NOT NULL,
    "recorded_date" DATETIME NOT NULL,
    "admission_mode" TEXT NOT NULL,
    "admission_operation_id" TEXT NOT NULL,
    "admission_receipt" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_reconciliation_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_owner_project_id_fkey" FOREIGN KEY ("owner_project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_source_expense_id_fkey" FOREIGN KEY ("source_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_source_cash_flow_entry_id_fkey" FOREIGN KEY ("source_cash_flow_entry_id") REFERENCES "cash_flow_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_bank_statement_import_id_fkey" FOREIGN KEY ("bank_statement_import_id") REFERENCES "bank_statement_imports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_card_statement_import_id_fkey" FOREIGN KEY ("card_statement_import_id") REFERENCES "credit_card_imports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_origin_card_id_fkey" FOREIGN KEY ("origin_card_id") REFERENCES "credit_cards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_destination_card_id_fkey" FOREIGN KEY ("destination_card_id") REFERENCES "credit_cards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_reconciliation_sources_admission_operation_id_fkey" FOREIGN KEY ("admission_operation_id") REFERENCES "invoice_replay_operations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CHECK (kind IN ('BANK_PAYMENT','CARD_TRANSFER','INVOICE_CREDIT')),
    CHECK (source_index >= 0 AND capacity_cents > 0),
    CHECK (admission_mode IN ('EXISTING_ASSOCIATION','ASSISTED_EXISTING_PAYMENT','DOCUMENTED_CREDIT')),
    CHECK (
      length(invoice_due_month) = 7
      AND invoice_due_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND substr(invoice_due_month,1,4) BETWEEN '0001' AND '9999'
      AND substr(invoice_due_month,6,2) BETWEEN '01' AND '12'
    ),
    CHECK (
      (kind = 'BANK_PAYMENT' AND source_index = 0
       AND bank_statement_import_id IS NOT NULL AND card_statement_import_id IS NULL
       AND account_id IS NOT NULL AND origin_card_id IS NULL
       AND admission_mode IN ('EXISTING_ASSOCIATION','ASSISTED_EXISTING_PAYMENT'))
      OR
      (kind = 'CARD_TRANSFER' AND source_index = 0
       AND bank_statement_import_id IS NULL AND account_id IS NULL
       AND origin_card_id IS NOT NULL AND origin_card_id <> destination_card_id
       AND source_cash_flow_entry_id IS NOT NULL
       AND admission_mode IN ('EXISTING_ASSOCIATION','ASSISTED_EXISTING_PAYMENT'))
      OR
      (kind = 'INVOICE_CREDIT' AND bank_statement_import_id IS NULL AND account_id IS NULL
       AND origin_card_id IS NOT NULL AND origin_card_id = destination_card_id
       AND source_cash_flow_entry_id IS NOT NULL AND admission_mode = 'DOCUMENTED_CREDIT')
    )
);

CREATE TABLE "invoice_replay_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "owner_project_id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "invoice_due_month" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "protocol_version" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "preview_fingerprint" TEXT NOT NULL,
    "resulting_fingerprint" TEXT NOT NULL,
    "receipt" TEXT NOT NULL,
    "public_result" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_replay_operations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_replay_operations_owner_project_id_fkey" FOREIGN KEY ("owner_project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_replay_operations_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "credit_cards" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_replay_operations_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CHECK (protocol_version = 1),
    CHECK (kind IN (
      'APPLY','UNDO_REPLAY','UNDO_SOURCE_REPLAY','UNDO_ORIGINAL_ADMISSION',
      'UNDO_BANK_IMPORT','UNDO_CARD_IMPORT','UNDO_TRANSFER','UNDO_CREDIT','UNDO_GRAPH'
    )),
    CHECK (
      length(invoice_due_month) = 7
      AND invoice_due_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND substr(invoice_due_month,1,4) BETWEEN '0001' AND '9999'
      AND substr(invoice_due_month,6,2) BETWEEN '01' AND '12'
    )
);

CREATE TABLE "invoice_funding_allocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "baseline_operation_id" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "purchase_expense_id" TEXT NOT NULL,
    "purchase_index" INTEGER NOT NULL,
    "cash_flow_entry_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "original_claim_id" TEXT,
    "reversed_by_operation_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "invoice_funding_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_funding_allocations_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "invoice_reconciliation_sources" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_funding_allocations_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "invoice_replay_operations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_funding_allocations_baseline_operation_id_fkey" FOREIGN KEY ("baseline_operation_id") REFERENCES "invoice_replay_operations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_funding_allocations_purchase_expense_id_fkey" FOREIGN KEY ("purchase_expense_id") REFERENCES "expenses" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_funding_allocations_cash_flow_entry_id_fkey" FOREIGN KEY ("cash_flow_entry_id") REFERENCES "cash_flow_entries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_funding_allocations_original_claim_id_fkey" FOREIGN KEY ("original_claim_id") REFERENCES "imported_invoice_liquidations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_funding_allocations_reversed_by_operation_id_fkey" FOREIGN KEY ("reversed_by_operation_id") REFERENCES "invoice_replay_operations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CHECK (amount_cents > 0 AND purchase_index >= 0),
    CHECK (layer IN ('ORIGINAL_COVERAGE','REPLAY')),
    CHECK (kind IN ('BANK_FUNDING','TRANSFER_FUNDING','CREDIT_OFFSET')),
    CHECK (
      (layer = 'ORIGINAL_COVERAGE' AND original_claim_id IS NOT NULL)
      OR (layer = 'REPLAY' AND original_claim_id IS NULL)
    ),
    CHECK (
      (deleted_at IS NULL AND reversed_by_operation_id IS NULL)
      OR (deleted_at IS NOT NULL AND reversed_by_operation_id IS NOT NULL)
    )
);

CREATE INDEX "invoice_reconciliation_sources_tenant_id_destination_card_id_invoice_due_month_idx" ON "invoice_reconciliation_sources"("tenant_id", "destination_card_id", "invoice_due_month");
CREATE INDEX "invoice_reconciliation_sources_bank_statement_import_id_idx" ON "invoice_reconciliation_sources"("bank_statement_import_id");
CREATE INDEX "invoice_reconciliation_sources_card_statement_import_id_idx" ON "invoice_reconciliation_sources"("card_statement_import_id");
CREATE UNIQUE INDEX "invoice_reconciliation_sources_origin_key" ON "invoice_reconciliation_sources"("tenant_id", "source_expense_id", "source_index");
CREATE UNIQUE INDEX "invoice_reconciliation_sources_cfe_key" ON "invoice_reconciliation_sources"("tenant_id", "source_cash_flow_entry_id");
CREATE INDEX "invoice_replay_operations_tenant_id_card_id_invoice_due_month_created_at_idx" ON "invoice_replay_operations"("tenant_id", "card_id", "invoice_due_month", "created_at");
CREATE UNIQUE INDEX "invoice_replay_operations_request_key" ON "invoice_replay_operations"("tenant_id", "actor_user_id", "idempotency_key");
CREATE INDEX "invoice_funding_allocations_tenant_id_source_id_deleted_at_idx" ON "invoice_funding_allocations"("tenant_id", "source_id", "deleted_at");
CREATE INDEX "invoice_funding_allocations_tenant_id_purchase_expense_id_purchase_index_deleted_at_idx" ON "invoice_funding_allocations"("tenant_id", "purchase_expense_id", "purchase_index", "deleted_at");
CREATE INDEX "invoice_funding_allocations_cash_flow_entry_id_idx" ON "invoice_funding_allocations"("cash_flow_entry_id");
CREATE INDEX "invoice_funding_allocations_original_claim_id_idx" ON "invoice_funding_allocations"("original_claim_id");
CREATE UNIQUE INDEX "invoice_funding_allocations_operation_pair_key" ON "invoice_funding_allocations"("operation_id", "source_id", "purchase_expense_id", "purchase_index", "layer");
