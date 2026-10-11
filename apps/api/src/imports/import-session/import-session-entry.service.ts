import { Inject, Injectable } from "@nestjs/common";
import {
  IMPORT_CHAT_CHANNEL,
  IMPORT_ENTRY_ACTION_KIND,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionDocumentFormat,
  type ImportChatChannel,
  type ImportEntryActionV1,
} from "@reformaflow/domain";
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
  importIntakeEnabled,
} from "./import-session.capability";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault/vault-state";

/** Deterministic pre-session availability hint. It never reads or mutates a session. */
@Injectable()
export class ImportSessionEntryService {
  constructor(
    @Inject(IMPORT_SESSION_CAPABILITY)
    private readonly capability: ImportSessionCapability,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
  ) {}

  action(
    originChannel: ImportChatChannel = IMPORT_CHAT_CHANNEL.TEXT,
  ): ImportEntryActionV1 {
    if (
      !importIntakeEnabled(this.capability) ||
      this.gate.boot.stopped.aborted ||
      !this.gate.boot.runtime()
    )
      return {
        version: IMPORT_SESSION_PROTOCOL_VERSION,
        kind: IMPORT_ENTRY_ACTION_KIND.UNAVAILABLE,
        originChannel,
      };
    return {
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      kind: IMPORT_ENTRY_ACTION_KIND.START_CARD_INVOICE_IMPORT,
      originChannel,
      formats: this.capability
        .newImportFormats()
        .filter(
          (
            format,
          ): format is
            | typeof ImportSessionDocumentFormat.CSV
            | typeof ImportSessionDocumentFormat.PDF =>
            format === ImportSessionDocumentFormat.CSV ||
            format === ImportSessionDocumentFormat.PDF,
        ),
      suggestedCardId: null,
    };
  }
}
