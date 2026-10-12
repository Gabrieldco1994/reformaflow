/** QA-only timing contract for the once-per-minute import-vault retention scheduler. */
export const IMPORT_VAULT_PURGE_SCHEDULER_INTERVAL_MS = 60_000;
export const QA_VAULT_PURGE_WAIT_MARGIN_MS = 15_000;
export const QA_VAULT_PURGE_WAIT_MS =
  IMPORT_VAULT_PURGE_SCHEDULER_INTERVAL_MS + QA_VAULT_PURGE_WAIT_MARGIN_MS;
