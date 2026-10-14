import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_RETENTION_DAYS,
  ProjectType,
  type PdfOcrDocumentV2,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { mintImportAuthContext } from "../import-session.auth";
import { DefaultImportSessionCapability } from "../import-session.capability";
import { ImportSessionExtractionService } from "../import-session.extraction.service";
import { ImportSessionWorkflowService } from "../import-session-workflow.service";
import { parseStoredPdfOcrState } from "./pdf-ocr-state";
import {
  PDF_OCR_CONSENT_DECISION,
  pdfOcrConsentQuestionId,
} from "./pdf-ocr-state";
import { parsePdfOcrV2 } from "./pdf-ocr-parser";
import { PdfOcrProviderError } from "./vertex-pdf-ocr.provider";
import { PDF_OCR_RETENTION_MS } from "./pdf-ocr-state";
import { VaultReaper } from "../vault/vault-reaper";

const now = new Date("2026-10-13T18:00:00.000Z");
const clock = { now: () => now };
const capability = new DefaultImportSessionCapability();
const verifier = { verify: jest.fn() };
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
  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.IMPORT_OCR_ENABLED;
    else process.env.IMPORT_OCR_ENABLED = originalFlag;
    if (originalProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = originalProject;
    await prisma.$disconnect();
  });

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
    expect(analyzed.lines).toHaveLength(1);
    expect(analyzed.selectedLineIds).toEqual([]);
    expect(analyzed.lines[0]!.ocrEvidence).toEqual({
      origin: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      region: PDF_OCR_REGION,
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
    expect(state.consents).toMatchObject([
      {
        attachmentId: owner.attachmentId,
        artifactSha256: owner.hash,
        requestId: request.requestId,
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
        attachmentId: owner.attachmentId,
        artifactSha256: owner.hash,
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
  pageCount: number,
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
      result: Promise.resolve({ kind: "OCR_ELIGIBLE", pageCount }),
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

async function fixture(prisma: PrismaService, label: string) {
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
      },
    })
  ).id;
  const sessionId = randomUUID();
  const attachmentId = randomUUID();
  const artifactId = randomUUID();
  const bytes = Buffer.from(`%PDF-1.4 direct-ocr-${label}`);
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
      tokenExpiresAt: "2026-10-14T00:00:00.000Z",
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
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      latencyMs: 25,
    },
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
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
