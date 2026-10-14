import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_RETENTION_DAYS,
  ExpenseType,
  ProjectType,
  type PdfOcrDocumentV2,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { ConciliacaoService } from "../../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../../expense/expense.service";
import { mintImportAuthContext } from "../import-session.auth";
import { CardPurchaseBatchAdapter } from "../card-purchase-batch.adapter";
import { DefaultImportSessionCapability } from "../import-session.capability";
import { ImportSessionExtractionService } from "../import-session.extraction.service";
import { ImportSessionService } from "../import-session.service";
import { ImportSessionWorkflowService } from "../import-session-workflow.service";
import { parseStoredPdfOcrState } from "./pdf-ocr-state";
import {
  PDF_OCR_CONSENT_DECISION,
  pdfOcrConsentQuestionId,
  pdfOcrRequestPayloadHash,
} from "./pdf-ocr-state";
import { parsePdfOcrV2 } from "./pdf-ocr-parser";
import { PdfOcrProviderError } from "./vertex-pdf-ocr.provider";
import { PDF_OCR_RETENTION_MS } from "./pdf-ocr-state";
import { VaultReaper } from "../vault/vault-reaper";
import { extractPdfDocument } from "../../../credit-card/parsers/pdf-document";
import { OCR_SYNTH_ROUTING_CASES } from "../../ocr-synth-v1/corpus";
import {
  artifactSha256,
  generateArtifact,
} from "../../ocr-synth-v1/fixture-generator";
import type { DocumentExtractionV1 } from "../../../credit-card/parsers/types";

const now = new Date("2026-10-13T18:00:00.000Z");
let current = now;
const clock = { now: () => current };
const capability = new DefaultImportSessionCapability();
const verifier = {
  verify: jest.fn(),
  verifyFinancialAction: jest.fn(),
};
const providerError = (
  failure: ConstructorParameters<typeof PdfOcrProviderError>[0],
  dispatchState: ConstructorParameters<typeof PdfOcrProviderError>[1],
) => new PdfOcrProviderError(failure, dispatchState);

describe("POST attachment analyze v2 direct OCR", () => {
  const prisma = new PrismaService();
  const originalFlag = process.env.IMPORT_OCR_ENABLED;
  const originalProject = process.env.GOOGLE_CLOUD_PROJECT;

  beforeAll(async () => {
    process.env.IMPORT_OCR_ENABLED = "true";
    process.env.GOOGLE_CLOUD_PROJECT = "approved-project";
    await prisma.$connect();
  });
  beforeEach(() => {
    current = now;
  });
  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.IMPORT_OCR_ENABLED;
    else process.env.IMPORT_OCR_ENABLED = originalFlag;
    if (originalProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = originalProject;
    await prisma.$disconnect();
  });

  it.each(OCR_SYNTH_ROUTING_CASES)(
    "routes real synthetic mixed case $id locally with zero OCR ledger or financial writes",
    async (testCase) => {
      const bytes = await generateArtifact(testCase);
      const localResult = await extractPdfDocument(bytes).catch(
        (error: unknown) =>
          error instanceof Error ? error : new Error("LOCAL_ROUTE_FAILED"),
      );
      const owner = await fixture(prisma, `route-${testCase.id}`, bytes);
      expect(owner.hash).toBe(artifactSha256(bytes));
      const provider = {
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        ready: () => true,
        extractPdf: jest.fn(),
      };
      const service = extraction(prisma, bytes, provider, localResult);

      const analysis = service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        { expectedRevision: 1 },
        {},
      );
      if (localResult instanceof Error)
        await expect(analysis).rejects.toBe(localResult);
      else await expect(analysis).resolves.toBeDefined();

      expect(provider.extractPdf).not.toHaveBeenCalled();
      expect(
        await prisma.importOcrUsage.count({
          where: { sessionId: owner.sessionId },
        }),
      ).toBe(0);
      expect(await financialCount(prisma, owner.tenantId)).toBe(0);
    },
  );

  it("persists server consent/fence, materializes unselected evidence, isolates tenant and replays once", async () => {
    const owner = await fixture(prisma, "happy");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockImplementation(async (request) =>
          document(owner.hash, "happy", request.requestId),
        ),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);

    const analyzed = await service.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );

    expect(provider.extractPdf).toHaveBeenCalledTimes(1);
    expect(provider.extractPdf).toHaveBeenCalledWith({
      artifactSha256: owner.hash,
      pageCount: 1,
      requestId: request.requestId,
      pdfBytes: owner.bytes,
      signal: expect.any(AbortSignal),
    });
    await expect(
      provider.extractPdf.mock.results[0]!.value,
    ).resolves.toMatchObject({
      provenance: { requestId: request.requestId },
    });
    expect(analyzed.lines).toHaveLength(1);
    expect(analyzed.selectedLineIds).toEqual([]);
    expect(analyzed.lines[0]!.ocrEvidence).toEqual({
      origin: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      modelVersion: "integration-fixture-v1",
      region: PDF_OCR_REGION,
      authTrace: "LOCAL_ADC",
      attachmentId: owner.attachmentId,
      artifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      pageNumber: 1,
      text: "13/10/2026 MERCADO 10,01",
    });
    const stored = await prisma.importSession.findUniqueOrThrow({
      where: { id: owner.sessionId },
    });
    const state = parseStoredPdfOcrState(stored.ocrJson);
    const expectedRequestPayloadHash = pdfOcrRequestPayloadHash(request);
    expect(state.consents).toMatchObject([
      {
        attachmentId: owner.attachmentId,
        artifactSha256: owner.hash,
        requestId: request.requestId,
        requestPayloadHash: expectedRequestPayloadHash,
        actorId: owner.userId,
        consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
        consentDecision: PDF_OCR_CONSENT_DECISION,
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        region: PDF_OCR_REGION,
        purpose: PDF_OCR_CONSENT_PURPOSE,
        retentionDays: PDF_OCR_RETENTION_DAYS,
        sendsFullOriginal: true,
        includesMetadataAndEmbeddedContent: true,
        includesPotentiallyNonVisibleContent: true,
        usageId: expect.any(String),
      },
    ]);
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { sessionId: owner.sessionId },
      }),
    ).toMatchObject({
      tenantId: owner.tenantId,
      ownerProjectId: owner.projectId,
      actorId: owner.userId,
      attachmentId: owner.attachmentId,
      artifactSha256: owner.hash,
      requestId: request.requestId,
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      modelVersion: "integration-fixture-v1",
      region: PDF_OCR_REGION,
      authTrace: "LOCAL_ADC",
      reservedPages: 1,
      outcome: "SUCCEEDED",
      responseId: "vertex-happy",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
    const observations = await prisma.importObservation.findMany({
      where: { tenantId: owner.tenantId },
    });
    expect(JSON.parse(observations[0]!.evidenceJson)).toMatchObject({
      ocr: {
        provenanceVersion: 2,
        usageId: expect.any(String),
        attachmentId: owner.attachmentId,
        artifactSha256: owner.hash,
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        modelVersion: "integration-fixture-v1",
        region: PDF_OCR_REGION,
        authTrace: "LOCAL_ADC",
        requestId: request.requestId,
        responseId: "vertex-happy",
      },
      text: "13/10/2026 MERCADO 10,01",
    });
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);

    const draft = JSON.parse(stored.draftJson);
    draft.selectedLineIds = [draft.lines[0].id];
    await prisma.importSession.update({
      where: { id: owner.sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
  });

  it("keeps every ordered OCR occurrence review-only through continuation, including payments and exact duplicates", async () => {
    const owner = await fixture(prisma, "all-lines");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockImplementation(async (request) =>
          allLinesDocument(owner.hash, request.requestId),
        ),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);
    const beforeFinance = await exactFinancialSnapshot(prisma, owner.tenantId);

    const analyzed = await service.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    const reader = new ImportSessionService(
      prisma,
      clock,
      capability,
      verifier as never,
      {
        boot: {
          runtime: () => ({}),
          stopped: new AbortController().signal,
        },
      } as never,
      { abortOwned: jest.fn() } as never,
    );
    const observations = await reader.getObservations(
      owner.auth,
      owner.sessionId,
    );
    const artifact = await prisma.importArtifact.findFirstOrThrow({
      where: {
        tenantId: owner.tenantId,
        ownerProjectId: owner.projectId,
      },
    });

    expect(provider.extractPdf).toHaveBeenCalledTimes(1);
    expect(analyzed.lines).toHaveLength(14);
    expect(analyzed.lines.map((line) => line.titulo)).toEqual([
      "PURCHASE",
      "PAGAMENTO DE FATURA CARTAO FINAL 0719",
      "CREDIT",
      "REFUND",
      "FEE",
      "INTEREST",
      "SUBTOTAL",
      "TOTAL",
      "PAID",
      "ADVANCE",
      "PARTIAL",
      "CARD PAYS CARD",
      "EXACT DUPLICATE",
      "EXACT DUPLICATE",
    ]);
    expect(analyzed.selectedLineIds).toEqual([]);
    expect(
      analyzed.lines.map((line) => ({
        amountMeaning: line.amountMeaning,
        amountCents: line.amountCents,
        decision: line.decision,
      })),
    ).toEqual(
      Array.from({ length: 14 }, () => ({
        amountMeaning: "UNKNOWN",
        amountCents: null,
        decision: { kind: "UNRESOLVED" },
      })),
    );
    expect(observations.items).toHaveLength(14);
    expect(
      [...observations.items]
        .sort(
          (left, right) =>
            Number(left.reference.split(":").at(-1)) -
            Number(right.reference.split(":").at(-1)),
        )
        .map((item) => ({
          reference: item.reference,
          text: item.text,
          amountCents: item.amountCents,
          ignoredReason: item.ignoredReason,
        })),
    ).toEqual([
      {
        reference: "ocr:page:1:candidate:1",
        text: "01 PURCHASE 123,45",
        amountCents: 12_345,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:2",
        text: "02 PAGAMENTO DE FATURA CARTAO FINAL 0719 -206,96",
        amountCents: -20_696,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:3",
        text: "03 CREDIT -5,00",
        amountCents: -500,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:4",
        text: "04 REFUND -7,00",
        amountCents: -700,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:5",
        text: "05 FEE 3,50",
        amountCents: 350,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:6",
        text: "06 INTEREST 2,10",
        amountCents: 210,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:7",
        text: "07 SUBTOTAL 100,00",
        amountCents: 10_000,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:8",
        text: "08 TOTAL 120,00",
        amountCents: 12_000,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:9",
        text: "09 PAID -120,00",
        amountCents: -12_000,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:10",
        text: "10 ADVANCE 0,00",
        amountCents: 0,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:11",
        text: "11 PARTIAL 15,00",
        amountCents: 1_500,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:12",
        text: "12 CARD PAYS CARD",
        amountCents: null,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:13",
        text: "13 EXACT DUPLICATE 9,99",
        amountCents: 999,
        ignoredReason: null,
      },
      {
        reference: "ocr:page:1:candidate:14",
        text: "13 EXACT DUPLICATE 9,99",
        amountCents: 999,
        ignoredReason: null,
      },
    ]);
    expect(artifact).toMatchObject({
      state: "EXTRACTED",
      parserVersion: "card-vertex-ocr-v2",
      extractionJson: expect.any(String),
    });
    expect(await exactFinancialSnapshot(prisma, owner.tenantId)).toEqual(
      beforeFinance,
    );

    const financialWorkflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      {
        writesEnabled: () => true,
        newImportFormats: capability.newImportFormats.bind(capability),
      },
      verifier as never,
      new CardPurchaseBatchAdapter(
        new ExpenseService(prisma, new ConciliacaoService(prisma)),
        new ConciliacaoService(prisma),
        clock,
      ),
      {
        boot: {
          runtime: () => ({}),
          stopped: new AbortController().signal,
        },
      } as never,
      { abortOwned: jest.fn() } as never,
    );
    const purchaseLineId = analyzed.lines[0]!.id;
    const purchaseObservationId = analyzed.lines[0]!.observationIds[0]!;
    let review = analyzed;
    for (const field of [
      "dataCompra",
      "merchant",
      "amountMeaning",
      "amountCents",
      "installmentCount",
      "installmentIndex",
    ] as const) {
      const currentQuestion = review.questions.find(
        (item) =>
          "subject" in item &&
          item.subject.kind === "OBSERVATION" &&
          item.subject.observationId === purchaseObservationId &&
          item.field === field,
      );
      if (!currentQuestion || !("subject" in currentQuestion))
        throw new Error("current observation question");
      const answer =
        currentQuestion.field === "dataCompra"
          ? {
              field: "dataCompra",
              value: "2026-10-13",
              meaningContext: null,
            }
          : currentQuestion.field === "merchant"
            ? {
                field: "merchant",
                value: "PURCHASE",
                meaningContext: null,
              }
            : currentQuestion.field === "amountMeaning"
              ? {
                  field: "amountMeaning",
                  value: "TOTAL_PURCHASE",
                  meaningContext: null,
                }
              : currentQuestion.field === "amountCents"
                ? {
                    field: "amountCents",
                    value: 12_345,
                    meaningContext: "TOTAL_PURCHASE",
                  }
                : currentQuestion.field === "installmentCount"
                  ? {
                      field: "installmentCount",
                      value: 1,
                      meaningContext: null,
                    }
                  : {
                      field: "installmentIndex",
                      value: 1,
                      meaningContext: null,
                    };
      review = await financialWorkflow.documentaryAnswer(
        owner.auth,
        owner.sessionId,
        {
          version: 1,
          answerRequestId: randomUUID(),
          expectedRevision: review.revision,
          questionId: currentQuestion.id,
          channel: "TEXT",
          input: {
            kind: "VALUE",
            text:
              currentQuestion.field === "amountMeaning"
                ? "total da compra"
                : currentQuestion.field === "amountCents"
                  ? "123,45"
                  : String(answer.value),
          },
          answer,
        } as never,
        {},
      );
    }
    const purchase = review.lines.find((line) => line.id === purchaseLineId)!;
    const { ocrEvidence: _ocrEvidence, ...editablePurchase } = purchase;
    review = await financialWorkflow.edit(owner.auth, owner.sessionId, {
      expectedRevision: review.revision,
      questionId: null,
      replaceLines: [
        {
          ...editablePurchase,
          titulo: "PURCHASE",
          fornecedor: "PURCHASE",
          tipoDespesa: ExpenseType.OUTROS,
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 12_345,
          installmentCount: 1,
          dataCompra: "2026-10-13",
          firstDueDate: "2026-10-20",
          targets: [],
          decision: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      ],
      selectedLineIds: [purchaseLineId],
    });
    expect(review.lines.slice(1).map((line) => line.decision)).toEqual(
      Array.from({ length: 13 }, () => ({ kind: "UNRESOLVED" })),
    );
    expect(review.selectedLineIds).toEqual([purchaseLineId]);
    expect(await exactFinancialSnapshot(prisma, owner.tenantId)).toEqual(
      beforeFinance,
    );

    const ready = await financialWorkflow.prepare(owner.auth, owner.sessionId, {
      expectedRevision: review.revision,
    });
    const challenge = await financialWorkflow.challenge(
      owner.auth,
      owner.sessionId,
      {
        expectedRevision: ready.revision,
        proposalHash: ready.proposal!.proposalHash,
      },
      {},
    );
    const financialRequestId = randomUUID();
    await financialWorkflow.confirm(
      owner.auth,
      owner.sessionId,
      {
        expectedRevision: ready.revision,
        proposalHash: ready.proposal!.proposalHash,
        financialRequestId,
        nonce: challenge.nonce,
      },
      {},
    );
    const receipt = await financialWorkflow.execute(
      owner.auth,
      owner.sessionId,
      { financialRequestId },
      {},
    );
    expect(await exactFinancialSnapshot(prisma, owner.tenantId)).toEqual({
      expenses: { count: 1, sumCents: 12_345 },
      cashFlow: { count: 1, sumCents: 12_345 },
      receipts: { count: 0, sumCents: 0 },
      allocations: { count: 0, sumCents: 0 },
      settlements: 0,
      invoiceLiquidations: 0,
    });
    expect(receipt.continuationSessionId).toEqual(expect.any(String));
    const continuation = await reader.getSession(
      owner.auth,
      receipt.continuationSessionId!,
    );
    expect({
      selectedLineIds: continuation.selectedLineIds,
      lines: continuation.lines.map((line) => ({
        titulo: line.titulo,
        amountMeaning: line.amountMeaning,
        amountCents: line.amountCents,
        decision: line.decision,
        hasOcrEvidence: line.ocrEvidence !== undefined,
      })),
    }).toEqual({
      selectedLineIds: [],
      lines: [
        "PAGAMENTO DE FATURA CARTAO FINAL 0719",
        "CREDIT",
        "REFUND",
        "FEE",
        "INTEREST",
        "SUBTOTAL",
        "TOTAL",
        "PAID",
        "ADVANCE",
        "PARTIAL",
        "CARD PAYS CARD",
        "EXACT DUPLICATE",
        "EXACT DUPLICATE",
      ].map((titulo) => ({
        titulo,
        amountMeaning: "UNKNOWN",
        amountCents: null,
        decision: { kind: "UNRESOLVED" },
        hasOcrEvidence: true,
      })),
    });
  });

  it.each(["LOCAL_ADC", "SERVICE_ACCOUNT_FILE_ADC"] as const)(
    "persists and projects exact %s provenance without exposing private transport identifiers",
    async (authTrace) => {
      const owner = await fixture(prisma, `provenance-${authTrace}`);
      const provider = {
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        ready: () => true,
        extractPdf: jest
          .fn()
          .mockImplementation(async (request) =>
            provenanceDocument(owner.hash, request.requestId, authTrace),
          ),
      };
      const service = extraction(prisma, owner.bytes, provider, 1);
      const request = await declareConsent(prisma, owner);

      const analyzed = await service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        request,
        {},
      );
      const usage = await prisma.$queryRawUnsafe<
        Array<{
          model: string;
          modelVersion: string | null;
          region: string | null;
          authTrace: string | null;
          requestId: string;
          responseId: string | null;
          inputTokens: bigint | number | null;
          outputTokens: bigint | number | null;
          totalTokens: bigint | number | null;
        }>
      >(
        `SELECT model,
                  model_version AS modelVersion,
                  region,
                  auth_trace AS authTrace,
                  request_id AS requestId,
                  response_id AS responseId,
                  input_tokens AS inputTokens,
                  output_tokens AS outputTokens,
                  total_tokens AS totalTokens
           FROM import_ocr_usage
           WHERE session_id = ?`,
        owner.sessionId,
      );
      expect(usage).toEqual([
        {
          model: PDF_OCR_MODEL_ID,
          modelVersion: "gemini-2.5-flash-719-release",
          region: PDF_OCR_REGION,
          authTrace,
          requestId: request.requestId,
          responseId: `vertex-provenance-${authTrace}`,
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
        },
      ]);
      const storedEvidence = JSON.parse(
        (
          await prisma.importObservation.findFirstOrThrow({
            where: { tenantId: owner.tenantId },
          })
        ).evidenceJson,
      );
      expect(storedEvidence.ocr).toMatchObject({
        attachmentId: owner.attachmentId,
        artifactSha256: owner.hash,
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        modelVersion: "gemini-2.5-flash-719-release",
        region: PDF_OCR_REGION,
        authTrace,
        requestId: request.requestId,
        responseId: `vertex-provenance-${authTrace}`,
      });
      expect(analyzed.lines[0]!.ocrEvidence).toMatchObject({
        origin: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        modelVersion: "gemini-2.5-flash-719-release",
        region: PDF_OCR_REGION,
        authTrace,
      });
      expect(analyzed.lines[0]!.ocrEvidence).not.toHaveProperty("requestId");
      expect(analyzed.lines[0]!.ocrEvidence).not.toHaveProperty("responseId");
      expect(analyzed.lines[0]!.ocrEvidence).not.toHaveProperty("credentials");
      expect(JSON.stringify(analyzed)).not.toContain("credential-canary-719");
      expect(await financialCount(prisma, owner.tenantId)).toBe(0);
    },
  );

  it("persists complete successful provenance even when OCR returns zero candidates", async () => {
    const owner = await fixture(prisma, "zero-candidates");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockImplementation(async (request) =>
          provenanceDocument(owner.hash, request.requestId, "LOCAL_ADC", []),
        ),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);

    const analyzed = await service.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    expect(analyzed.lines).toEqual([]);
    expect(analyzed.selectedLineIds).toEqual([]);
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT outcome, model_version, region, auth_trace, request_id, response_id,
                  input_tokens, output_tokens, total_tokens
           FROM import_ocr_usage
           WHERE session_id = ?`,
        owner.sessionId,
      ),
    ).toEqual([
      {
        outcome: "SUCCEEDED",
        model_version: "gemini-2.5-flash-719-release",
        region: PDF_OCR_REGION,
        auth_trace: "LOCAL_ADC",
        request_id: request.requestId,
        response_id: "vertex-provenance-LOCAL_ADC",
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
      },
    ]);
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);
  });

  it.each([
    [
      "modelVersion",
      (value: Record<string, unknown>) => delete value.modelVersion,
    ],
    ["region", (value: Record<string, unknown>) => delete value.region],
    [
      "authTrace",
      (value: Record<string, unknown>) => {
        delete (value.requestTrace as Record<string, unknown>).authTrace;
      },
    ],
    ["requestId", (value: Record<string, unknown>) => delete value.requestId],
    ["responseId", (value: Record<string, unknown>) => delete value.responseId],
  ] as const)(
    "rejects missing %s as MALFORMED_RESPONSE with zero publication",
    async (field, remove) => {
      const owner = await fixture(prisma, `missing-${field}`);
      const provider = {
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        ready: () => true,
        extractPdf: jest.fn().mockImplementation(async (request) => {
          const document = structuredClone(
            provenanceDocument(owner.hash, request.requestId, "LOCAL_ADC"),
          ) as unknown as { provenance: Record<string, unknown> };
          remove(document.provenance);
          return document;
        }),
      };
      const service = extraction(prisma, owner.bytes, provider as never, 1);
      const request = await declareConsent(prisma, owner);

      await expect(
        service.analyzeAttached(
          owner.auth,
          owner.sessionId,
          owner.attachmentId,
          request,
          {},
        ),
      ).rejects.toMatchObject({ code: "OCR_MALFORMED_RESPONSE" });
      expect(
        await prisma.importOcrUsage.findFirstOrThrow({
          where: { sessionId: owner.sessionId },
        }),
      ).toMatchObject({
        outcome: "MALFORMED_RESPONSE",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        responseId: null,
      });
      expect(
        await prisma.importObservation.count({
          where: { tenantId: owner.tenantId },
        }),
      ).toBe(0);
      expect(
        await prisma.importArtifact.findFirstOrThrow({
          where: { tenantId: owner.tenantId },
        }),
      ).toMatchObject({
        state: "RAW_READY",
        parserVersion: null,
        extractionJson: null,
      });
      expect(await financialCount(prisma, owner.tenantId)).toBe(0);
    },
  );

  it("purges OCR content on request at the inclusive deadline and repeats idempotently without a scheduler", async () => {
    const owner = await fixture(prisma, "request-retention");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockImplementation(async (request) =>
          provenanceDocument(owner.hash, request.requestId, "LOCAL_ADC"),
        ),
    };
    const extractionService = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);
    const analyzed = await extractionService.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    const stored = await prisma.importSession.findUniqueOrThrow({
      where: { id: owner.sessionId },
    });
    const localArtifact = await prisma.importArtifact.findFirstOrThrow({
      where: {
        tenantId: owner.tenantId,
        ownerProjectId: owner.projectId,
      },
    });
    const [localOnlyObservationId, mixedObservationId] = [
      randomUUID(),
      randomUUID(),
    ];
    const localEvidence = (id: string, title: string, cents: number) =>
      JSON.stringify({
        sourceDescription: title,
        version: 1,
        reference: `local:${id}`,
        text: title,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: cents,
        installmentCount: 1,
        installmentIndex: null,
        dataCompra: "2026-10-13",
        identity: {
          merchant: title,
          externalId: null,
          fitId: null,
          ordinal: 0,
          fileContentHash: "f".repeat(32),
        },
      });
    await prisma.importObservation.createMany({
      data: [
        {
          id: localOnlyObservationId,
          tenantId: owner.tenantId,
          ownerProjectId: owner.projectId,
          artifactId: localArtifact.id,
          reference: `local:${localOnlyObservationId}`,
          evidenceJson: localEvidence(
            localOnlyObservationId,
            "LOCAL SURVIVES",
            777,
          ),
        },
        {
          id: mixedObservationId,
          tenantId: owner.tenantId,
          ownerProjectId: owner.projectId,
          artifactId: localArtifact.id,
          reference: `local:${mixedObservationId}`,
          evidenceJson: localEvidence(
            mixedObservationId,
            "LOCAL HALF OF MIXED LINE",
            888,
          ),
        },
      ],
    });
    const draft = JSON.parse(stored.draftJson);
    draft.lines[0].observationIds.push(mixedObservationId);
    const localLineId = randomUUID();
    draft.lines.push({
      id: localLineId,
      observationIds: [localOnlyObservationId],
      titulo: "LOCAL SURVIVES",
      fornecedor: "LOCAL SURVIVES",
      tipoDespesa: null,
      categoriaMaoDeObra: null,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 777,
      installmentCount: 1,
      dataCompra: "2026-10-13",
      firstDueDate: null,
      targets: null,
      decision: { kind: "UNRESOLVED" },
    });
    draft.scope.observationIds.push(localOnlyObservationId, mixedObservationId);
    draft.selectedLineIds = [draft.lines[0].id];
    await prisma.importSession.update({
      where: { id: owner.sessionId },
      data: {
        draftJson: JSON.stringify(draft),
        expiresAt: new Date(
          now.getTime() + PDF_OCR_RETENTION_MS + 30 * 86_400_000,
        ),
      },
    });
    const reader = new ImportSessionService(
      prisma,
      clock,
      capability,
      verifier as never,
      {
        boot: {
          runtime: () => ({}),
          stopped: new AbortController().signal,
          recheckLock: async () => ({ ok: true, runtime: {} }),
        },
      } as never,
      { abortOwned: jest.fn() } as never,
    );
    const usageBefore = await prisma.importOcrUsage.findFirstOrThrow({
      where: { sessionId: owner.sessionId },
    });
    const deadline = new Date(
      usageBefore.createdAt.getTime() + PDF_OCR_RETENTION_MS,
    );

    current = new Date(deadline.getTime() - 1);
    const beforeDeadline = await reader.getSession(owner.auth, owner.sessionId);
    expect(beforeDeadline.lines).toHaveLength(2);
    expect(beforeDeadline.selectedLineIds).toEqual([draft.lines[0].id]);
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { id: usageBefore.id },
      }),
    ).toMatchObject({ contentPurgedAt: null });

    current = deadline;
    const atDeadline = await reader.getSession(owner.auth, owner.sessionId);
    expect(atDeadline.lines).toHaveLength(1);
    expect(atDeadline.lines[0]).toMatchObject({
      id: localLineId,
      titulo: "LOCAL SURVIVES",
      observationIds: [localOnlyObservationId],
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 777,
      decision: { kind: "UNRESOLVED" },
    });
    expect(atDeadline.lines[0]).not.toHaveProperty("ocrEvidence");
    expect(atDeadline.selectedLineIds).toEqual([]);
    expect(atDeadline.questions).toEqual([]);
    expect(atDeadline.declaredFacts).toEqual([]);
    expect(atDeadline.proposal).toBeNull();
    expect(atDeadline.confirmation).toBeNull();
    const purged = await prisma.importSession.findUniqueOrThrow({
      where: { id: owner.sessionId },
    });
    expect(purged).toMatchObject({
      revision: analyzed.revision + 1,
      state: "REVIEW_REQUIRED",
      searchJson: null,
      proposalJson: null,
      proposalHash: null,
      preflightHash: null,
      challengeJson: null,
      prepareLeaseJson: null,
      financialRequestId: null,
    });
    expect(JSON.parse(purged.draftJson)).toEqual({
      version: 1,
      lines: [
        expect.objectContaining({
          id: localLineId,
          observationIds: [localOnlyObservationId],
        }),
      ],
      selectedLineIds: [],
      questions: [],
      scope: {
        observationIds: [localOnlyObservationId, mixedObservationId],
        pendingAttachmentIds: [],
      },
    });
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { id: usageBefore.id },
      }),
    ).toMatchObject({
      contentPurgedAt: deadline,
      model: PDF_OCR_MODEL_ID,
      requestId: request.requestId,
      responseId: "vertex-provenance-LOCAL_ADC",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
    expect(
      await prisma.importObservation.count({
        where: { tenantId: owner.tenantId },
      }),
    ).toBe(2);
    expect(
      await prisma.importArtifact.findFirstOrThrow({
        where: { id: usageBefore.artifactId },
      }),
    ).toMatchObject({
      state: "RAW_READY",
      parserVersion: null,
      extractionJson: null,
    });
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);

    current = new Date(deadline.getTime() + 1);
    const repeated = await reader.getSession(owner.auth, owner.sessionId);
    expect(repeated.lines).toHaveLength(1);
    expect(repeated.lines[0]!.id).toBe(localLineId);
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: owner.sessionId },
      }),
    ).toMatchObject({ revision: analyzed.revision + 1 });
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { id: usageBefore.id },
      }),
    ).toMatchObject({ contentPurgedAt: deadline });
  });

  it("quarantines legacy successful rows with incomplete provenance and rolls a failed purge back before projection", async () => {
    const owner = await fixture(prisma, "legacy-provenance-quarantine");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockImplementation(async (request) =>
          provenanceDocument(owner.hash, request.requestId, "LOCAL_ADC"),
        ),
    };
    const extractionService = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);
    const analyzed = await extractionService.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    const usage = await prisma.importOcrUsage.findFirstOrThrow({
      where: { sessionId: owner.sessionId },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE import_ocr_usage
         SET model_version = NULL, region = NULL, auth_trace = NULL
         WHERE id = ?`,
      usage.id,
    );
    const reader = new ImportSessionService(
      prisma,
      clock,
      capability,
      verifier as never,
      {
        boot: {
          runtime: () => ({}),
          stopped: new AbortController().signal,
          recheckLock: async () => ({ ok: true, runtime: {} }),
        },
      } as never,
      { abortOwned: jest.fn() } as never,
    );
    await prisma.$executeRawUnsafe(`
        CREATE TRIGGER fail_legacy_ocr_quarantine
        BEFORE DELETE ON import_observations
        BEGIN
          SELECT RAISE(ABORT, 'private-trigger-canary-719');
        END
      `);
    try {
      await expect(
        reader.getSession(owner.auth, owner.sessionId),
      ).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
      expect(
        await prisma.importSession.findUniqueOrThrow({
          where: { id: owner.sessionId },
        }),
      ).toMatchObject({ revision: analyzed.revision });
      expect(
        await prisma.importOcrUsage.findFirstOrThrow({
          where: { id: usage.id },
        }),
      ).toMatchObject({ contentPurgedAt: null });
      expect(
        await prisma.importObservation.count({
          where: { tenantId: owner.tenantId },
        }),
      ).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_legacy_ocr_quarantine",
      );
    }

    const retry = await reader.getSession(owner.auth, owner.sessionId);
    expect(retry.lines).toEqual([]);
    expect(retry.selectedLineIds).toEqual([]);
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { id: usage.id },
      }),
    ).toMatchObject({ contentPurgedAt: now });
    expect(JSON.stringify(retry)).not.toContain("gemini-2.5-flash-719-release");
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);
  });
  it("requires attestation before replaying immutable OCR evidence", async () => {
    const owner = await fixture(prisma, "happy-attestation");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockImplementation(async (request) =>
          document(owner.hash, "happy-attestation", request.requestId),
        ),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);
    const analyzed = await service.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    const stored = await prisma.importSession.findUniqueOrThrow({
      where: { id: owner.sessionId },
    });
    const draft = JSON.parse(stored.draftJson);
    draft.selectedLineIds = [draft.lines[0].id];
    await prisma.importSession.update({
      where: { id: owner.sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    const gate = {
      boot: {
        runtime: () => ({}),
        stopped: new AbortController().signal,
      },
    };
    const batches = { prepareInTx: jest.fn() };
    const workflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      verifier as never,
      batches as never,
      gate as never,
      { abortOwned: jest.fn() } as never,
    );
    await expect(
      workflow.prepare(owner.auth, owner.sessionId, {
        expectedRevision: analyzed.revision,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    expect(batches.prepareInTx).not.toHaveBeenCalled();
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);
    const merchantQuestion = analyzed.questions.find(
      (question) =>
        "subject" in question &&
        question.field === "merchant" &&
        question.subject.kind === "OBSERVATION",
    );
    expect(merchantQuestion).toBeDefined();
    if (!merchantQuestion || !("subject" in merchantQuestion))
      throw new Error("missing OCR merchant question");
    const attested = await workflow.documentaryAnswer(
      owner.auth,
      owner.sessionId,
      {
        version: 1,
        answerRequestId: randomUUID(),
        expectedRevision: analyzed.revision,
        questionId: merchantQuestion.id,
        channel: "TEXT",
        input: { kind: "VALUE", text: "MERCADO" },
        answer: {
          field: "merchant",
          value: "MERCADO",
          meaningContext: null,
        },
      },
      {},
    );
    const { ocrEvidence: _viewEvidence, ...editableLine } = attested.lines[0]!;
    const corrected = await workflow.edit(owner.auth, owner.sessionId, {
      expectedRevision: attested.revision,
      questionId: null,
      replaceLines: [{ ...editableLine, titulo: "MERCADO CORRIGIDO" }],
      selectedLineIds: attested.selectedLineIds,
    });
    const correctedRow = await prisma.importSession.findUniqueOrThrow({
      where: { id: corrected.id },
    });
    expect(JSON.parse(correctedRow.draftJson).declarations.items).toEqual([]);

    const replay = await service.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    expect(replay.lines).toHaveLength(1);
    expect(replay.lines[0]!.ocrEvidence).toEqual(
      analyzed.lines[0]!.ocrEvidence,
    );
    expect(replay.revision).toBe(corrected.revision);
    expect(provider.extractPdf).toHaveBeenCalledTimes(1);
    await expect(
      service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        { ...request, expectedRevision: corrected.revision },
        {},
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        { ...request, requestId: randomUUID() },
        {},
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const outsider = await fixture(prisma, "outsider");
    await expect(
      service.analyzeAttached(
        outsider.auth,
        owner.sessionId,
        owner.attachmentId,
        request,
        {},
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(provider.extractPdf).toHaveBeenCalledTimes(1);

    const retentionNow = new Date(now.getTime() + PDF_OCR_RETENTION_MS);
    for (const extensionDays of [14, 30])
      await prisma.importSession.update({
        where: { id: owner.sessionId },
        data: {
          expiresAt: new Date(
            retentionNow.getTime() + extensionDays * 86_400_000,
          ),
        },
      });
    const runtime = {};
    const reaper = new VaultReaper(
      prisma,
      { now: () => retentionNow },
      {
        boot: {
          runtime: () => runtime,
          stopped: new AbortController().signal,
          recheckLock: async () => ({ ok: true as const, runtime }),
        },
        requirePurger: () => ({ purge: jest.fn() }),
      } as never,
      { abortOwned: jest.fn() } as never,
    );
    await reaper.runCycle({
      tenantId: owner.tenantId,
      ownerProjectId: owner.projectId,
      limit: 10,
    });
    const retained = await prisma.importSession.findUniqueOrThrow({
      where: { id: owner.sessionId },
    });
    expect(retained.expiresAt.getTime()).toBeGreaterThan(
      retentionNow.getTime(),
    );
    expect(retained.state).toBe("REVIEW_REQUIRED");
    expect(JSON.parse(retained.draftJson).lines).toEqual([]);
    expect(parseStoredPdfOcrState(retained.ocrJson).consents[0]).toMatchObject({
      requestId: request.requestId,
      usageId: expect.any(String),
    });
    expect(
      await prisma.importObservation.count({
        where: { tenantId: owner.tenantId },
      }),
    ).toBe(0);
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { sessionId: owner.sessionId },
      }),
    ).toMatchObject({
      outcome: "SUCCEEDED",
      contentPurgedAt: expect.any(Date),
    });
  });

  it("leaves timeout UNKNOWN and never retries the provider", async () => {
    const owner = await fixture(prisma, "timeout");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockRejectedValue(providerError("TIMEOUT", "DISPATCHED_OR_UNKNOWN")),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);

    await expect(
      service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        request,
        {},
      ),
    ).rejects.toMatchObject({ code: "OCR_ATTEMPT_UNKNOWN" });
    expect(provider.extractPdf).toHaveBeenCalledTimes(1);
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { sessionId: owner.sessionId },
      }),
    ).toMatchObject({ outcome: "UNKNOWN" });
    await expect(
      service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        request,
        {},
      ),
    ).rejects.toMatchObject({ code: "OCR_ATTEMPT_UNKNOWN" });
    expect(provider.extractPdf).toHaveBeenCalledTimes(1);
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);
  });

  it("persists and replays an exact terminal safety failure", async () => {
    const owner = await fixture(prisma, "safety");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest
        .fn()
        .mockRejectedValue(providerError("SAFETY", "DISPATCHED_OR_UNKNOWN")),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);

    await expect(
      service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        request,
        {},
      ),
    ).rejects.toMatchObject({ code: "OCR_SAFETY_BLOCKED" });
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { sessionId: owner.sessionId },
      }),
    ).toMatchObject({ outcome: "SAFETY" });
    await expect(
      service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        request,
        {},
      ),
    ).rejects.toMatchObject({ code: "OCR_SAFETY_BLOCKED" });
    expect(provider.extractPdf).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "MALFORMED_RESPONSE",
      "DISPATCHED_OR_UNKNOWN",
      "OCR_MALFORMED_RESPONSE",
      "MALFORMED_RESPONSE",
    ],
    [
      "MALFORMED_RESPONSE",
      "NOT_DISPATCHED",
      "OCR_UNAVAILABLE",
      "NOT_DISPATCHED",
    ],
    ["AUTH", "NOT_DISPATCHED", "OCR_UNAVAILABLE", "NOT_DISPATCHED"],
    ["RATE_LIMITED", "DISPATCHED_OR_UNKNOWN", "OCR_ATTEMPT_UNKNOWN", "UNKNOWN"],
    ["UPSTREAM", "DISPATCHED_OR_UNKNOWN", "OCR_ATTEMPT_UNKNOWN", "UNKNOWN"],
  ] as const)(
    "persists and replays terminal %s/%s without retry",
    async (failure, dispatchState, code, outcome) => {
      const owner = await fixture(
        prisma,
        `terminal-${failure}-${dispatchState}`,
      );
      const provider = {
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        ready: () => true,
        extractPdf: jest
          .fn()
          .mockRejectedValue(providerError(failure, dispatchState)),
      };
      const service = extraction(prisma, owner.bytes, provider, 1);
      const request = await declareConsent(prisma, owner);
      for (let invocation = 0; invocation < 2; invocation += 1)
        await expect(
          service.analyzeAttached(
            owner.auth,
            owner.sessionId,
            owner.attachmentId,
            request,
            {},
          ),
        ).rejects.toMatchObject({ code });
      expect(
        await prisma.importOcrUsage.findFirstOrThrow({
          where: { sessionId: owner.sessionId },
        }),
      ).toMatchObject({ outcome });
      expect(provider.extractPdf).toHaveBeenCalledTimes(1);
      expect(await financialCount(prisma, owner.tenantId)).toBe(0);
    },
  );

  it.each([
    ["RATE_LIMITED", "OCR_ATTEMPT_UNKNOWN"],
    ["UPSTREAM", "OCR_ATTEMPT_UNKNOWN"],
    ["ATTEMPTED", "OCR_ATTEMPT_UNKNOWN"],
    ["UNKNOWN", "OCR_ATTEMPT_UNKNOWN"],
    ["AUTH", "OCR_UNAVAILABLE"],
    ["NOT_DISPATCHED", "OCR_UNAVAILABLE"],
  ] as const)(
    "replays legacy %s without retry as %s",
    async (outcome, code) => {
      const owner = await fixture(prisma, `legacy-${outcome}`);
      const provider = {
        provider: PDF_OCR_PROVIDER_ID,
        model: PDF_OCR_MODEL_ID,
        ready: () => true,
        extractPdf: jest
          .fn()
          .mockRejectedValue(providerError("SAFETY", "DISPATCHED_OR_UNKNOWN")),
      };
      const service = extraction(prisma, owner.bytes, provider, 1);
      const request = await declareConsent(prisma, owner);

      await expect(
        service.analyzeAttached(
          owner.auth,
          owner.sessionId,
          owner.attachmentId,
          request,
          {},
        ),
      ).rejects.toMatchObject({ code: "OCR_SAFETY_BLOCKED" });
      await prisma.importOcrUsage.updateMany({
        where: { sessionId: owner.sessionId },
        data: { outcome },
      });
      await expect(
        service.analyzeAttached(
          owner.auth,
          owner.sessionId,
          owner.attachmentId,
          request,
          {},
        ),
      ).rejects.toMatchObject({ code });
      expect(provider.extractPdf).toHaveBeenCalledTimes(1);
      expect(await financialCount(prisma, owner.tenantId)).toBe(0);
    },
  );

  it("fails unavailable before consent/grant when the project is blank", async () => {
    const owner = await fixture(prisma, "missing-project");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest.fn(),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const previous = process.env.GOOGLE_CLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = "   ";
    try {
      await expect(
        service.analyzeGrantScope(
          owner.auth,
          owner.sessionId,
          owner.attachmentId,
          {
            version: 2,
            expectedRevision: 1,
            requestId: randomUUID(),
            consentExternalProcessing: true,
          },
        ),
      ).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
    } finally {
      process.env.GOOGLE_CLOUD_PROJECT = previous;
    }
    expect(provider.extractPdf).not.toHaveBeenCalled();
    expect(
      await prisma.importOcrUsage.count({
        where: { sessionId: owner.sessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: owner.sessionId },
      }),
    ).toMatchObject({ ocrJson: null });
  });

  it("rejects a handcrafted v2 boolean without prior durable consent", async () => {
    const owner = await fixture(prisma, "no-consent");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest.fn(),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    await expect(
      service.analyzeGrantScope(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        {
          version: 2,
          expectedRevision: 1,
          requestId: randomUUID(),
          consentExternalProcessing: true,
        },
      ),
    ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
    expect(provider.extractPdf).not.toHaveBeenCalled();
    expect(
      await prisma.importOcrUsage.count({
        where: { sessionId: owner.sessionId },
      }),
    ).toBe(0);
  });

  it("admits only one provider call for concurrent v2 analysis", async () => {
    const owner = await fixture(prisma, "concurrent");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest.fn().mockImplementation(async (request) => {
        entered();
        await held;
        return document(owner.hash, "concurrent", request.requestId);
      }),
    };
    const service = extraction(prisma, owner.bytes, provider, 1);
    const request = await declareConsent(prisma, owner);
    const first = service.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    await providerEntered;
    const second = service.analyzeAttached(
      owner.auth,
      owner.sessionId,
      owner.attachmentId,
      request,
      {},
    );
    await expect(second).rejects.toMatchObject({ code: expect.any(String) });
    release();
    await expect(first).resolves.toMatchObject({ selectedLineIds: [] });
    expect(provider.extractPdf).toHaveBeenCalledTimes(1);
  });

  it("rejects an observed eleven-page raster PDF before consent or network", async () => {
    const owner = await fixture(prisma, "oversize");
    const provider = {
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      ready: () => true,
      extractPdf: jest.fn(),
    };
    const service = extraction(prisma, owner.bytes, provider, 11);
    const request = await declareConsent(prisma, owner);

    await expect(
      service.analyzeAttached(
        owner.auth,
        owner.sessionId,
        owner.attachmentId,
        request,
        {},
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(provider.extractPdf).not.toHaveBeenCalled();
    const row = await prisma.importSession.findUniqueOrThrow({
      where: { id: owner.sessionId },
    });
    expect(parseStoredPdfOcrState(row.ocrJson).consents[0]).toMatchObject({
      requestId: request.requestId,
      usageId: null,
    });
    expect(
      await prisma.importOcrUsage.count({
        where: { sessionId: owner.sessionId },
      }),
    ).toBe(0);
  });
});

async function declareConsent(
  prisma: PrismaService,
  owner: Awaited<ReturnType<typeof fixture>>,
) {
  const requestId = randomUUID();
  const runtime = {};
  const workflow = new ImportSessionWorkflowService(
    prisma,
    clock,
    capability,
    verifier as never,
    { prepareInTx: jest.fn() } as never,
    {
      boot: {
        runtime: () => runtime,
        stopped: new AbortController().signal,
      },
    } as never,
    { abortOwned: jest.fn() } as never,
  );
  const questionId = pdfOcrConsentQuestionId({
    tenantId: owner.tenantId,
    sessionId: owner.sessionId,
    revision: 1,
    attachmentId: owner.attachmentId,
    artifactSha256: owner.hash,
  });
  const view = await workflow.documentaryAnswer(
    owner.auth,
    owner.sessionId,
    {
      version: 1,
      answerRequestId: randomUUID(),
      expectedRevision: 1,
      questionId,
      channel: "TEXT",
      input: { kind: "VALUE", text: "ALLOW_EXTERNAL_PROCESSING" },
      answer: {
        field: "externalOcrConsent",
        value: "ALLOW_EXTERNAL_PROCESSING",
        attachmentId: owner.attachmentId,
        requestId,
        consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
        provider: PDF_OCR_PROVIDER_ID,
        purpose: PDF_OCR_CONSENT_PURPOSE,
        region: PDF_OCR_REGION,
        retentionDays: PDF_OCR_RETENTION_DAYS,
        sendsFullOriginal: true,
        includesMetadataAndEmbeddedContent: true,
        includesPotentiallyNonVisibleContent: true,
      },
    },
    {},
  );
  expect(view.revision).toBe(2);
  expect(view.ocrCapability).toMatchObject({
    status: "AVAILABLE",
    consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
    provider: PDF_OCR_PROVIDER_ID,
    purpose: PDF_OCR_CONSENT_PURPOSE,
    region: PDF_OCR_REGION,
    retentionDays: PDF_OCR_RETENTION_DAYS,
    sendsFullOriginal: true,
    includesMetadataAndEmbeddedContent: true,
    attachments: [
      {
        attachmentId: owner.attachmentId,
        consentedRequestId: requestId,
        consentedRevision: 2,
      },
    ],
  });
  return {
    version: 2 as const,
    expectedRevision: view.revision,
    requestId,
    consentExternalProcessing: true as const,
  };
}

function extraction(
  prisma: PrismaService,
  bytes: Buffer,
  provider: {
    provider: typeof PDF_OCR_PROVIDER_ID;
    model: typeof PDF_OCR_MODEL_ID;
    ready(): boolean;
    extractPdf: jest.Mock;
  },
  result: number | DocumentExtractionV1 | Error,
): ImportSessionExtractionService {
  const runtime = {};
  const gate = {
    boot: {
      runtime: () => runtime,
      stopped: new AbortController().signal,
      recheckLock: async () => ({ ok: true, runtime }),
    },
    storage: {
      withArtifactReader: async (
        _scope: unknown,
        authorize: () => Promise<void>,
        read: (source: Readable) => Promise<unknown>,
      ) => {
        await authorize();
        return read(Readable.from([bytes]));
      },
    },
  };
  const admission = { signal: new AbortController().signal };
  const raw = {
    assertAvailable: jest.fn(),
    admit: jest.fn(() => admission),
    assertLive: jest.fn(),
    startPdf: jest.fn(() => ({
      result:
        result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(
              typeof result === "number"
                ? { kind: "OCR_ELIGIBLE", pageCount: result }
                : { kind: "SUCCESS", document: result },
            ),
      settled: Promise.resolve({ cleanup: "CLEAN" }),
    })),
    startCsv: jest.fn(),
    close: jest.fn(),
  };
  return new ImportSessionExtractionService(
    prisma,
    clock,
    capability,
    verifier as never,
    gate as never,
    raw as never,
    provider,
  );
}

async function fixture(
  prisma: PrismaService,
  label: string,
  fixtureBytes?: Buffer,
) {
  const tenantId = (
    await prisma.tenant.create({ data: { name: `OCR ${label}` } })
  ).id;
  const userId = (
    await prisma.user.create({
      data: {
        tenantId,
        username: randomUUID(),
        name: `OCR ${label}`,
        role: "ADMIN",
      },
    })
  ).id;
  const projectId = (
    await prisma.project.create({
      data: {
        tenantId,
        name: `OCR ${label}`,
        type: ProjectType.PESSOAL,
      },
    })
  ).id;
  const cardId = (
    await prisma.creditCard.create({
      data: {
        tenantId,
        projectId,
        nickname: `OCR ${label}`,
        institution: "fixture",
        last4: "0719",
        closingDay: 15,
        dueDay: 20,
      },
    })
  ).id;
  const sessionId = randomUUID();
  const attachmentId = randomUUID();
  const artifactId = randomUUID();
  const bytes = fixtureBytes ?? Buffer.from(`%PDF-1.4 direct-ocr-${label}`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await prisma.importSession.create({
    data: {
      id: sessionId,
      tenantId,
      ownerUserId: userId,
      ownerProjectId: projectId,
      cardId,
      kind: "CREATE_CARD_PURCHASES",
      state: "DRAFT",
      revision: 1,
      createRequestId: randomUUID(),
      createPayloadHash: "b".repeat(64),
      consentPolicyVersion: 1,
      consentedAt: now,
      lastUserEditAt: now,
      expiresAt: new Date("2026-10-14T18:00:00.000Z"),
      draftJson: JSON.stringify({
        version: 1,
        lines: [],
        selectedLineIds: [],
        questions: [],
        scope: {
          observationIds: [],
          pendingAttachmentIds: [attachmentId],
        },
      }),
    },
  });
  await prisma.importArtifact.create({
    data: {
      id: artifactId,
      tenantId,
      ownerProjectId: projectId,
      documentSha256: hash,
      verifiedBytes: bytes.length,
      detectedFormat: "PDF",
      state: "RAW_READY",
      storageKey: `t/${artifactId}`,
    },
  });
  await prisma.importSessionArtifact.create({
    data: {
      id: attachmentId,
      tenantId,
      ownerProjectId: projectId,
      sessionId,
      artifactId,
      position: 0,
      fileName: "scan.pdf",
      declaredMime: "application/pdf",
      declaredBytes: bytes.length,
      state: "ATTACHED",
      reservedBytes: bytes.length,
      verifiedAt: now,
    },
  });
  return {
    tenantId,
    userId,
    projectId,
    sessionId,
    attachmentId,
    bytes,
    hash,
    auth: mintImportAuthContext({
      tenantId,
      userId,
      presentedSessionVersion: 0,
      tokenExpiresAt: "2026-11-30T00:00:00.000Z",
    }),
  };
}

function document(
  hash: string,
  suffix: string,
  requestId: string,
): PdfOcrDocumentV2 {
  const evidenceText = "13/10/2026 MERCADO 10,01";
  const parsed = parsePdfOcrV2(
    {
      candidates: [
        {
          pageNumber: 1,
          description: "MERCADO",
          amountCents: "1001",
          amountMeaning: "LINE_AMOUNT",
          date: "2026-10-13",
          installment: null,
          evidenceText,
        },
      ],
    },
    {
      artifactSha256: hash,
      pageCount: 1,
      requestId,
      responseId: `vertex-${suffix}`,
      modelVersion: "integration-fixture-v1",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      latencyMs: 25,
      requestTrace: {
        requestId,
        endpoint: "https://southamerica-east1-aiplatform.googleapis.com",
        authTrace: "LOCAL_ADC",
        adcScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        inputMimeType: "application/pdf",
        inputMode: "INLINE_ORIGINAL_BYTES",
        originalBytesSha256: hash,
        requestBodyBytes: 1,
        deadlineMs: 60_000,
        finishReason: "STOP",
        maxOutputTokens: 8192,
        promptSha256: "a".repeat(64),
        toolsPresent: false,
        fileUri: null,
        cachedContent: null,
      },
    },
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function allLinesDocument(hash: string, requestId: string): PdfOcrDocumentV2 {
  const rows = [
    ["PURCHASE", "12345", "01 PURCHASE 123,45"],
    [
      "PAGAMENTO DE FATURA CARTAO FINAL 0719",
      "-20696",
      "02 PAGAMENTO DE FATURA CARTAO FINAL 0719 -206,96",
    ],
    ["CREDIT", "-500", "03 CREDIT -5,00"],
    ["REFUND", "-700", "04 REFUND -7,00"],
    ["FEE", "350", "05 FEE 3,50"],
    ["INTEREST", "210", "06 INTEREST 2,10"],
    ["SUBTOTAL", "10000", "07 SUBTOTAL 100,00"],
    ["TOTAL", "12000", "08 TOTAL 120,00"],
    ["PAID", "-12000", "09 PAID -120,00"],
    ["ADVANCE", "0", "10 ADVANCE 0,00"],
    ["PARTIAL", "1500", "11 PARTIAL 15,00"],
    ["CARD PAYS CARD", null, "12 CARD PAYS CARD"],
    ["EXACT DUPLICATE", "999", "13 EXACT DUPLICATE 9,99"],
    ["EXACT DUPLICATE", "999", "13 EXACT DUPLICATE 9,99"],
  ] as const;
  const parsed = parsePdfOcrV2(
    {
      candidates: rows.map(([description, amountCents, evidenceText]) => ({
        pageNumber: 1,
        description,
        amountCents,
        amountMeaning: amountCents === null ? "UNKNOWN" : "LINE_AMOUNT",
        date: "2026-10-13",
        installment: null,
        evidenceText,
      })),
    },
    {
      artifactSha256: hash,
      pageCount: 1,
      requestId,
      responseId: "vertex-all-lines",
      modelVersion: "integration-all-lines-v1",
      usage: { inputTokens: 70, outputTokens: 42, totalTokens: 112 },
      latencyMs: 25,
      requestTrace: {
        requestId,
        endpoint:
          "https://southamerica-east1-aiplatform.googleapis.com/v1/projects/project-719/locations/southamerica-east1/publishers/google/models/gemini-2.5-flash:generateContent",
        authTrace: "LOCAL_ADC",
        adcScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        inputMimeType: "application/pdf",
        inputMode: "INLINE_ORIGINAL_BYTES",
        originalBytesSha256: hash,
        requestBodyBytes: 1_024,
        deadlineMs: 30_000,
        finishReason: "STOP",
        maxOutputTokens: 8_192,
        promptSha256: "e".repeat(64),
        toolsPresent: false,
        fileUri: null,
        cachedContent: null,
      },
    },
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function provenanceDocument(
  hash: string,
  requestId: string,
  authTrace: "LOCAL_ADC" | "SERVICE_ACCOUNT_FILE_ADC",
  candidates: Array<{
    pageNumber: number;
    description: string | null;
    amountCents: string | null;
    amountMeaning: "LINE_AMOUNT" | "UNKNOWN";
    date: string | null;
    installment: { index: number; total: number } | null;
    evidenceText: string;
  }> = [
    {
      pageNumber: 1,
      description: "PROVENANCE PURCHASE",
      amountCents: "20696",
      amountMeaning: "LINE_AMOUNT",
      date: "2026-10-13",
      installment: null,
      evidenceText: "13/10/2026 PROVENANCE PURCHASE 206,96",
    },
  ],
): PdfOcrDocumentV2 {
  const parsed = parsePdfOcrV2(
    { candidates },
    {
      artifactSha256: hash,
      pageCount: 1,
      requestId,
      responseId: `vertex-provenance-${authTrace}`,
      modelVersion: "gemini-2.5-flash-719-release",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      latencyMs: 25,
      requestTrace: {
        requestId,
        endpoint:
          "https://southamerica-east1-aiplatform.googleapis.com/v1/projects/project-719/locations/southamerica-east1/publishers/google/models/gemini-2.5-flash:generateContent",
        authTrace,
        adcScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        inputMimeType: "application/pdf",
        inputMode: "INLINE_ORIGINAL_BYTES",
        originalBytesSha256: hash,
        requestBodyBytes: 512,
        deadlineMs: 30_000,
        finishReason: "STOP",
        maxOutputTokens: 8_192,
        promptSha256: "d".repeat(64),
        toolsPresent: false,
        fileUri: null,
        cachedContent: null,
      },
    },
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

async function exactFinancialSnapshot(
  prisma: PrismaService,
  tenantId: string,
): Promise<{
  expenses: { count: number; sumCents: number };
  cashFlow: { count: number; sumCents: number };
  receipts: { count: number; sumCents: number };
  allocations: { count: number; sumCents: number };
  settlements: number;
  invoiceLiquidations: number;
}> {
  const [expenses, cashFlow, receipts, allocations, settlements, liquidations] =
    await Promise.all([
      prisma.expense.aggregate({
        where: { tenantId },
        _count: { _all: true },
        _sum: { valorTotal: true },
      }),
      prisma.cashFlowEntry.aggregate({
        where: { tenantId },
        _count: { _all: true },
        _sum: { valor: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId },
        _count: { _all: true },
        _sum: { valor: true },
      }),
      prisma.rateioAllocation.aggregate({
        where: { tenantId },
        _count: { _all: true },
        _sum: { allocation: true },
      }),
      prisma.crossProjectSettlement.count({ where: { tenantId } }),
      prisma.importedInvoiceLiquidation.count({ where: { tenantId } }),
    ]);
  return {
    expenses: {
      count: expenses._count._all,
      sumCents: expenses._sum.valorTotal ?? 0,
    },
    cashFlow: {
      count: cashFlow._count._all,
      sumCents: cashFlow._sum.valor ?? 0,
    },
    receipts: {
      count: receipts._count._all,
      sumCents: receipts._sum.valor ?? 0,
    },
    allocations: {
      count: allocations._count._all,
      sumCents: allocations._sum.allocation ?? 0,
    },
    settlements,
    invoiceLiquidations: liquidations,
  };
}

async function financialCount(
  prisma: PrismaService,
  tenantId: string,
): Promise<number> {
  const counts = await Promise.all([
    prisma.expense.count({ where: { tenantId } }),
    prisma.cashFlowEntry.count({ where: { tenantId } }),
    prisma.receipt.count({ where: { tenantId } }),
    prisma.rateioAllocation.count({ where: { tenantId } }),
    prisma.crossProjectSettlement.count({ where: { tenantId } }),
    prisma.importedInvoiceLiquidation.count({ where: { tenantId } }),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
}
