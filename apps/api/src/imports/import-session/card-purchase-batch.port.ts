import type { Prisma } from "@prisma/client";
import type {
  ImportSessionCandidateV1,
  ImportSessionHash,
  ImportSessionId,
  ImportSessionReceiptV1,
  ImportSessionRevision,
  ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import type {
  AuthenticatedImportContext,
  LockedImportSession,
  PreparedCardBatch,
} from "./import-session.contract";

export const CARD_PURCHASE_BATCH_PORT = Symbol("CARD_PURCHASE_BATCH_PORT");

export type ImportCandidateRef = Pick<
  ImportSessionCandidateV1,
  "lineId" | "kind" | "id" | "reason"
>;

export type SearchStage =
  | "DOCUMENT_IDENTITY"
  | "CROSS_ORIGIN"
  | "CARD_IDENTITY";

export type SearchStep =
  | {
      lineId: ImportSessionId;
      stage: SearchStage;
      status: "NOT_RUN";
      predicateHash: null;
      visitedRows: 0;
      endCursor: null;
    }
  | {
      lineId: ImportSessionId;
      stage: SearchStage;
      status: "EXHAUSTED";
      predicateHash: ImportSessionHash;
      visitedRows: number;
      endCursor: null;
    };

/** Private coverage, not proof of queries or a resumable/public candidate cursor. */
export interface StoredImportSearchV1 {
  version: 1;
  revision: ImportSessionRevision;
  complete: boolean;
  candidates: ImportCandidateRef[];
  coverage: {
    recipe: "CARD_PURCHASE_V1";
    inputHash: ImportSessionHash;
    steps: SearchStep[];
  };
}

export type CardPurchasePreparation =
  | {
      kind: "READY";
      draft: ImportSessionStoredDraftV1;
      search: StoredImportSearchV1 & { complete: true };
      batch: PreparedCardBatch;
    }
  | {
      kind: "NEEDS_INPUT" | "REVIEW_REQUIRED";
      draft: ImportSessionStoredDraftV1;
      search: StoredImportSearchV1;
      batch?: never;
    };

/**
 * The coordinator owns one writer-first transaction: current auth/ACL, session and
 * empty-claim identity/version rechecks -> reprepare/preflight -> effects -> ONE complete
 * binding CAS per observation -> continuation/cleanup -> audit/final receipt/APPLIED.
 * Entities exist before binding their FKs; any post-effect failure must throw/roll back
 * everything, never return REVIEW_REQUIRED. No nested transactions, IO or egress here.
 * No provider is registered until the financial implementation and its gates pass.
 */
export interface CardPurchaseBatchPort {
  prepareInTx(
    tx: Prisma.TransactionClient,
    auth: AuthenticatedImportContext,
    session: LockedImportSession,
  ): Promise<CardPurchasePreparation>;
  applyInTx(
    tx: Prisma.TransactionClient,
    auth: AuthenticatedImportContext,
    batch: PreparedCardBatch,
  ): Promise<ImportSessionReceiptV1["items"]>;
}
