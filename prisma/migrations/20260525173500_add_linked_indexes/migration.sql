-- Indices para acelerar lookups "quem aponta pra mim?" e "qual é a série?"
CREATE INDEX "receipts_linked_receipt_id_idx" ON "receipts"("linked_receipt_id");
CREATE INDEX "expenses_linked_expense_id_idx" ON "expenses"("linked_expense_id");
CREATE INDEX "expenses_series_key_idx" ON "expenses"("series_key");
