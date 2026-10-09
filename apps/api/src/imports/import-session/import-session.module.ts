import { Module } from "@nestjs/common";
import { ConciliacaoModule } from "../../conciliacao/conciliacao.module";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseModule } from "../../expense/expense.module";
import { ExpenseService } from "../../expense/expense.service";
import { PrismaModule } from "../../prisma/prisma.module";
import { PrismaService } from "../../prisma/prisma.service";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import {
  CARD_PURCHASE_BATCH_PORT,
  type CardPurchaseBatchPort,
} from "./card-purchase-batch.port";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { ImportAuthGuard } from "./import-session.auth";
import {
  DefaultImportSessionCapability,
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  IMPORT_SESSION_GRANT_VERIFIER,
  SystemImportSessionClock,
  type ImportSessionCapability,
  type ImportSessionClock,
} from "./import-session.capability";
import type { UiImportFinancialActionVerifier } from "./import-session.contract";
import { ImportSessionController } from "./import-session.controller";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionExtractionService } from "./import-session.extraction.service";
import {
  ImportRawExecutions,
  IMPORT_X2_NATIVE_CONFIG,
} from "./import-session.raw-executions";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import {
  EnvImportSessionUiOrigins,
  IMPORT_SESSION_UI_ORIGINS,
  ImportUiGuard,
} from "./import-session-ui.guard";
import {
  IMPORT_VAULT_GATE,
  createImportVaultGate,
  type ImportVaultGate,
} from "./vault/vault-state";
import { ImportAttachmentController } from "./vault/import-attachment.controller";
import { ImportUploadService } from "./vault/import-upload.service";
import { ImportContentService } from "./vault/import-content.service";
import { VaultReaper } from "./vault/vault-reaper";
import { VaultRetentionScheduler } from "./vault/vault-retention.scheduler";
import { ImportChatGuard } from "./import-chat.guard";
import { ImportChatBridge } from "./import-chat.bridge";

/**
 * Only the contextual guard and restricted bridge leave this module.
 * Financial providers and the grant issuer remain private; writes stay OFF.
 */
@Module({
  imports: [PrismaModule, ExpenseModule, ConciliacaoModule],
  controllers: [ImportSessionController, ImportAttachmentController],
  providers: [
    ImportChatGuard,
    ImportChatBridge,
    ImportSessionService,
    ImportSessionExtractionService,
    ImportRawExecutions,
    { provide: IMPORT_X2_NATIVE_CONFIG, useValue: null },
    ImportUploadService,
    ImportContentService,
    VaultReaper,
    VaultRetentionScheduler,
    ImportUiGrantIssuer,
    ImportUiGuard,
    ImportAuthGuard,
    { provide: IMPORT_SESSION_CLOCK, useClass: SystemImportSessionClock },
    {
      provide: IMPORT_SESSION_CAPABILITY,
      useClass: DefaultImportSessionCapability,
    },
    {
      provide: IMPORT_SESSION_GRANT_VERIFIER,
      useClass: RuntimeUiGrantVerifier,
    },
    { provide: IMPORT_SESSION_UI_ORIGINS, useClass: EnvImportSessionUiOrigins },
    {
      provide: CARD_PURCHASE_BATCH_PORT,
      inject: [ExpenseService, ConciliacaoService, IMPORT_SESSION_CLOCK],
      useFactory: (
        expenses: ExpenseService,
        conciliacao: ConciliacaoService,
        clock: ImportSessionClock,
      ): CardPurchaseBatchPort =>
        new CardPurchaseBatchAdapter(expenses, conciliacao, clock),
    },
    {
      provide: ImportSessionWorkflowService,
      inject: [
        PrismaService,
        IMPORT_SESSION_CLOCK,
        IMPORT_SESSION_CAPABILITY,
        IMPORT_SESSION_GRANT_VERIFIER,
        CARD_PURCHASE_BATCH_PORT,
        IMPORT_VAULT_GATE,
        ImportRawExecutions,
      ],
      useFactory: (
        prisma: PrismaService,
        clock: ImportSessionClock,
        capability: ImportSessionCapability,
        verifier: UiImportFinancialActionVerifier,
        batches: CardPurchaseBatchPort,
        gate: ImportVaultGate,
        raw: ImportRawExecutions,
      ): ImportSessionWorkflowService =>
        new ImportSessionWorkflowService(
          prisma,
          clock,
          capability,
          verifier,
          batches,
          gate,
          raw,
        ),
    },
    {
      provide: IMPORT_VAULT_GATE,
      inject: [PrismaService, IMPORT_SESSION_CLOCK],
      useFactory: (prisma: PrismaService, clock: ImportSessionClock) =>
        createImportVaultGate(prisma, clock, process.env, process.cwd()),
    },
  ],
  exports: [ImportChatGuard, ImportChatBridge],
})
export class ImportSessionModule {}
