import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionErrorCode,
  type ExpenseScheduleV1,
  type ImportSessionConfirmRequestV1,
  type ImportSessionConfirmResponseV1,
  type ImportSessionErrorV1,
  type ImportSessionEditRequestV1,
  type ImportSessionEntryV1,
  type ImportSessionListV1,
  type ImportSessionProposalV1,
  type ImportSessionReceiptV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionViewV1,
  type Receipt,
} from "@reformaflow/domain";
import type { Prisma } from "@prisma/client";
import type { CardPurchaseBatchPort } from "./card-purchase-batch.port";
import {
  DefaultImportSessionCapability,
  type ImportSessionCapability,
} from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  LockedImportSession,
  UiImportPersistenceGrant,
} from "./import-session.contract";

describe("import-session bootstrap public contract (not endpoint validation)", () => {
  it("entry_and_new_import_formats_are_required", () => {
    const entry: ImportSessionEntryV1 = {
      kind: "CARD_INVOICE",
      version: 1,
      formats: ["CSV"],
    };
    const page: ImportSessionListV1 = {
      items: [],
      nextCursor: null,
      entry,
    };
    const unavailable: ImportSessionEntryV1 = {
      kind: "UNAVAILABLE",
      version: 1,
      reason: "RUNTIME_UNAVAILABLE",
    };
    const compile = (capability: ImportSessionCapability): void => {
      const formats: readonly "CSV"[] = capability.newImportFormats();
      // @ts-expect-error Entry is required on the public list, including an empty page.
      const missing: ImportSessionListV1 = { items: [], nextCursor: null };
      // @ts-expect-error Every producer must implement the synchronous formats query.
      const incomplete: ImportSessionCapability = {
        writesEnabled: () => false,
      };
      const image: ImportSessionEntryV1 = {
        kind: "CARD_INVOICE",
        version: 1,
        // @ts-expect-error Image support does not qualify the card-invoice RAW entry.
        formats: ["PNG"],
      };
      // @ts-expect-error UNAVAILABLE always carries its bounded server reason.
      const missingReason: ImportSessionEntryV1 = {
        kind: "UNAVAILABLE",
        version: 1,
      };
      const empty: ImportSessionEntryV1 = {
        kind: "CARD_INVOICE",
        version: 1,
        // @ts-expect-error The positive format tuple is non-empty.
        formats: [],
      };
      void [formats, missing, incomplete, image, missingReason, empty];
    };
    expect(typeof compile).toBe("function");
    expect(page.entry).toBe(entry);
    expect(unavailable.reason).toBe("RUNTIME_UNAVAILABLE");
    expect(new DefaultImportSessionCapability().newImportFormats()).toEqual([]);
  });

  it("pins every finite budget independently of the production constant", () => {
    expect(IMPORT_SESSION_LIMITS).toEqual({
      filesPerRequest: 5,
      bytesPerFile: 10485760,
      filesPerSession: 10,
      bytesPerSession: 52428800,
      activeSessionsPerUser: 3,
      activeSessionsPerTenant: 20,
      storedAndReservedBytesPerTenant: 209715200,
      storedAndReservedBytesGlobal: 1073741824,
      concurrentUploadsPerTenant: 2,
      concurrentParsersPerTenant: 1,
      concurrentParsersGlobal: 2,
      uploadLeaseSeconds: 120,
      parserLeaseSeconds: 90,
      parserDeadlineSeconds: 60,
      confirmationNonceSeconds: 300,
      csvColumnsPerFile: 64,
      csvFieldBytes: 1000,
      draftRetentionSeconds: 604800,
      pdfPagesPerFile: 30,
      pdfPagesPerSession: 60,
      imagePixels: 16000000,
      expandedArchiveBytes: 52428800,
      expandedArchiveEntries: 1000,
      parsedRowsPerFile: 1000,
      parsedRowsPerSession: 2000,
      editableLines: 100,
      selectedLines: 10,
      installmentsPerPurchase: 24,
      targetsPerPurchase: 1,
      expandedCFEsPerBatch: 240,
      financialAndCoordinationWritesPerBatch: 512,
      matchingRowsVisitedPerPreparation: 5000,
      jsonBytesPerDraftOrProposal: 1048576,
      transactionMaxWaitMs: 5000,
      transactionTimeoutMs: 20000,
      writeAttempts: 3,
      pageSize: 25,
      cursorSeconds: 900,
      reaperIntervalSeconds: 60,
      observationsPerLine: 20,
    });
  });

  it("keeps parent IDs distinct from UUIDv4 request IDs and pins primitive ranges", () => {
    expect(
      new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test("dev-tenant-1"),
    ).toBe(true);
    expect(
      new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test("cmlegacycard123"),
    ).toBe(true);
    expect(new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test("bad/id")).toBe(
      false,
    );
    expect(
      new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern).test(
        "dev-tenant-1",
      ),
    ).toBe(false);
    expect(
      new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern).test(
        "123e4567-e89b-42d3-a456-426614174000",
      ),
    ).toBe(true);
    expect(IMPORT_SESSION_PRIMITIVES).toMatchObject({
      minRevision: 1,
      maxRevision: 2147483647,
      minCents: -2147483647,
      maxCents: 2147483647,
      minPurchaseCents: 1,
      minYear: 1900,
      maxYear: 2199,
      maxTitleLength: 160,
      maxSupplierLength: 160,
      maxFileNameLength: 255,
      maxQuestionLength: 500,
      maxReferenceLength: 192,
      maxObservationTextLength: 1000,
    });
    expect(ImportSessionErrorCode.SESSION_EXPIRED).toBe("SESSION_EXPIRED");
    expect(ImportSessionErrorCode.ALREADY_APPLIED).toBe("ALREADY_APPLIED");
  });

  it("compiles addendum wire types, native transaction port and unforgeable grant type", () => {
    const request: ImportSessionConfirmRequestV1 = {
      expectedRevision: 1,
      confirmationHash: "a".repeat(64),
      financialRequestId: "123e4567-e89b-42d3-a456-426614174000",
      nonce: null,
    };
    const response: ImportSessionConfirmResponseV1 = {
      sessionId: "session",
      financialRequestId: request.financialRequestId,
      state: "REVIEW_REQUIRED",
    };
    // Compile-only assertions: never fabricate an authenticated/locked runtime context.
    const compile = (
      view: ImportSessionViewV1,
      proposal: ImportSessionProposalV1,
      financialReceipt: Receipt,
      tx: Prisma.TransactionClient,
      port: CardPurchaseBatchPort,
      auth: AuthenticatedImportContext,
      locked: LockedImportSession,
      receipt: ImportSessionReceiptV1,
      edit: ImportSessionEditRequestV1,
    ): void => {
      const confirmation: ImportSessionViewV1["confirmation"] =
        view.confirmation;
      const blockers: Array<{
        lineId: string;
        code: "ORIGINAL_IDENTITY_INCOMPLETE" | "ORIGINAL_OCCURRENCE_INCOMPLETE";
      }> = view.reviewBlockers;
      const analysis: ImportSessionViewV1["actions"][number] = "ANALYZE";
      const completion: boolean | undefined =
        view.attachments[0]?.materializedInSession;
      const eligible: boolean | undefined = view.attachments[0]?.canAnalyze;
      const { reviewBlockers: omittedBlockers, ...withoutBlockers } = view;
      // @ts-expect-error Documentary blockers are required even when empty.
      const incompleteView: ImportSessionViewV1 = withoutBlockers;
      void [
        blockers,
        analysis,
        completion,
        eligible,
        omittedBlockers,
        incompleteView,
      ];
      const schedule: ExpenseScheduleV1 | undefined =
        proposal.lines[0]?.schedule;
      const receiptValue: number = financialReceipt.valor;
      void [
        confirmation,
        schedule,
        receiptValue,
        port.prepareInTx(tx, auth, locked),
      ];
      // @ts-expect-error A native transaction client must not open nested public transactions.
      void tx.$transaction;
      // @ts-expect-error A request boolean is not an internal UI capability.
      const forged: UiImportPersistenceGrant = { consentAnalyze: true };
      void forged;
      // AC18: continuation pointer, deferred attachments and private scope are mandatory.
      const continuation: string | null = receipt.continuationSessionId;
      const deferredAttachments: string[] = proposal.deferredAttachmentIds;
      const scope: ImportSessionStoredDraftV1["scope"] = locked.draft.scope;
      const pending: string[] = locked.draft.scope.pendingAttachmentIds;
      void [continuation, deferredAttachments, scope, pending];
      const {
        continuationSessionId: omittedPointer,
        ...receiptWithoutPointer
      } = receipt;
      void omittedPointer;
      // @ts-expect-error continuationSessionId is required (nullable, never omitted).
      const incompleteReceipt: ImportSessionReceiptV1 = receiptWithoutPointer;
      void incompleteReceipt;
      const { deferredAttachmentIds: omittedDeferred, ...proposalWithout } =
        proposal;
      void omittedDeferred;
      // @ts-expect-error deferredAttachmentIds is required even when empty.
      const incompleteProposal: ImportSessionProposalV1 = proposalWithout;
      void incompleteProposal;
      // AC18 freeze: retention deadline and the machine reason are mandatory (nullable).
      const retain: string | null = proposal.retainUntil;
      void retain;
      const { retainUntil: omittedRetain, ...proposalWithoutRetain } = proposal;
      void omittedRetain;
      // @ts-expect-error retainUntil is required (nullable, never omitted).
      const proposalMissingRetain: ImportSessionProposalV1 =
        proposalWithoutRetain;
      void proposalMissingRetain;
      const okError: ImportSessionErrorV1 = {
        code: "STALE_PREVIEW",
        retryable: false,
        sessionId: null,
        currentRevision: null,
        reason: "ATTACHMENT_IN_FLIGHT",
      };
      const nullReason: ImportSessionErrorV1["reason"] = null;
      const budget: ImportSessionErrorV1["reason"] = "WRITE_BUDGET_EXCEEDED";
      void [okError, nullReason, budget];
      // @ts-expect-error reason is a closed union, not a free string (and no new error code).
      const badReason: ImportSessionErrorV1["reason"] = "SOMETHING_ELSE";
      void badReason;
      const { reason: omittedReason, ...errorWithoutReason } = okError;
      void omittedReason;
      // @ts-expect-error reason is required (nullable, never omitted).
      const errorMissingReason: ImportSessionErrorV1 = errorWithoutReason;
      void errorMissingReason;
      const { scope: omittedScope, ...draftWithoutScope } = locked.draft;
      void omittedScope;
      // @ts-expect-error the stored draft always carries the server-owned scope.
      const incompleteDraft: ImportSessionStoredDraftV1 = draftWithoutScope;
      void incompleteDraft;
      // @ts-expect-error scope is server-owned: not part of the public view.
      void view.scope;
      // @ts-expect-error scope is server-owned: PATCH bodies cannot carry it.
      void edit.scope;
      const { confirmation: removed, ...withoutConfirmation } = view;
      void removed;
      // @ts-expect-error confirmation is mandatory even before it becomes non-null.
      const incomplete: ImportSessionViewV1 = withoutConfirmation;
      void incomplete;
    };
    expect(typeof compile).toBe("function");
    // Literal barrier: the empty cleanup document shape is pinned independently.
    const emptyStoredDraft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: { observationIds: [], pendingAttachmentIds: [] },
    };
    expect(JSON.stringify(emptyStoredDraft)).toBe(
      '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
    );
    expect(response.state).toBe("REVIEW_REQUIRED");
  });
});
