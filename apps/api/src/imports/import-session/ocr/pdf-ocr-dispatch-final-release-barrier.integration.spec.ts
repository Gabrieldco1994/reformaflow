import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_RETENTION_DAYS,
  ProjectType,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { mintImportAuthContext } from "../import-session.auth";
import { DefaultImportSessionCapability } from "../import-session.capability";
import { ImportSessionExtractionService } from "../import-session.extraction.service";
import { ImportSessionWorkflowService } from "../import-session-workflow.service";
import {
  pdfOcrConsentQuestionId,
  type PdfOcrAnalyzeRequestV2,
} from "./pdf-ocr-state";
import { VertexPdfOcrProvider } from "./vertex-pdf-ocr.provider";

const NOW = new Date("2026-10-13T20:00:00.000Z");
const clock = { now: () => NOW };
const capability = new DefaultImportSessionCapability();
const verifier = { verify: jest.fn() };

describe("final #719 provider dispatch fence", () => {
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

  it("records a token failure as pre-dispatch and terminal without uploading or retrying", async () => {
    const owner = await fixture(prisma, "pre-dispatch");
    const accessToken = jest.fn().mockRejectedValue(new Error("ADC rejected"));
    const fetcher = jest.fn();
    const provider = new VertexPdfOcrProvider(
      "approved-project",
      { authTrace: "LOCAL_ADC", accessToken },
      fetcher,
    );
    const service = extraction(prisma, owner, provider);
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
      ).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });

    expect(accessToken).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await prisma.importOcrUsage.findFirstOrThrow({
        where: { sessionId: owner.sessionId },
      }),
    ).toMatchObject({
      outcome: "NOT_DISPATCHED",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      responseId: null,
    });
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);
  });

  it("treats an HTTP failure after full-PDF dispatch as UNKNOWN and never retries", async () => {
    const owner = await fixture(prisma, "post-dispatch");
    const accessToken = jest.fn().mockResolvedValue("adc-token");
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      body: null,
    });
    const provider = new VertexPdfOcrProvider(
      "approved-project",
      { authTrace: "LOCAL_ADC", accessToken },
      fetcher,
    );
    const service = extraction(prisma, owner, provider);
    const request = await declareConsent(prisma, owner);

    const codes: string[] = [];
    for (let invocation = 0; invocation < 2; invocation += 1)
      codes.push(
        await service
          .analyzeAttached(
            owner.auth,
            owner.sessionId,
            owner.attachmentId,
            request,
            {},
          )
          .then(
            () => "RESOLVED",
            (error: { code?: string }) => error.code ?? "UNTYPED",
          ),
      );

    const usage = await prisma.importOcrUsage.findFirstOrThrow({
      where: { sessionId: owner.sessionId },
    });
    expect(await financialCount(prisma, owner.tenantId)).toBe(0);
    expect({
      codes,
      accessTokenCalls: accessToken.mock.calls.length,
      fetchCalls: fetcher.mock.calls.length,
      outcome: usage.outcome,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      responseId: usage.responseId,
    }).toEqual({
      codes: ["OCR_ATTEMPT_UNKNOWN", "OCR_ATTEMPT_UNKNOWN"],
      accessTokenCalls: 1,
      fetchCalls: 1,
      outcome: "UNKNOWN",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      responseId: null,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse(init.body).contents[0].parts).toEqual([
      expect.objectContaining({ text: expect.any(String) }),
      {
        inlineData: {
          mimeType: "application/pdf",
          data: owner.bytes.toString("base64"),
        },
      },
    ]);
  });
});

async function declareConsent(
  prisma: PrismaService,
  owner: Awaited<ReturnType<typeof fixture>>,
): Promise<PdfOcrAnalyzeRequestV2> {
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
  const view = await workflow.documentaryAnswer(
    owner.auth,
    owner.sessionId,
    {
      version: 1,
      answerRequestId: randomUUID(),
      expectedRevision: 1,
      questionId: pdfOcrConsentQuestionId({
        tenantId: owner.tenantId,
        sessionId: owner.sessionId,
        revision: 1,
        attachmentId: owner.attachmentId,
        artifactSha256: owner.hash,
      }),
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
  expect(view.ocrCapability).toEqual({
    status: "AVAILABLE",
    consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
    provider: PDF_OCR_PROVIDER_ID,
    purpose: PDF_OCR_CONSENT_PURPOSE,
    region: PDF_OCR_REGION,
    retentionDays: PDF_OCR_RETENTION_DAYS,
    sendsFullOriginal: true,
    includesMetadataAndEmbeddedContent: true,
    includesPotentiallyNonVisibleContent: true,
    attachments: [
      {
        attachmentId: owner.attachmentId,
        questionId: expect.stringMatching(/^ocrq_[a-f0-9]{64}$/),
        consentedRequestId: requestId,
        consentedRevision: 2,
      },
    ],
  });
  expect(view.ocrCapability).not.toHaveProperty("terminalOutcomes");
  return {
    version: 2,
    expectedRevision: 2,
    requestId,
    consentExternalProcessing: true,
  };
}

function extraction(
  prisma: PrismaService,
  owner: Awaited<ReturnType<typeof fixture>>,
  provider: VertexPdfOcrProvider,
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
        return read(Readable.from([owner.bytes]));
      },
    },
  };
  const admission = { signal: new AbortController().signal };
  const raw = {
    assertAvailable: jest.fn(),
    admit: jest.fn(() => admission),
    assertLive: jest.fn(),
    startPdf: jest.fn(() => ({
      result: Promise.resolve({ kind: "OCR_ELIGIBLE", pageCount: 1 }),
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
  const bytes = Buffer.from(`%PDF-1.4 dispatch-${label}`);
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
      consentedAt: NOW,
      lastUserEditAt: NOW,
      expiresAt: new Date("2026-10-14T20:00:00.000Z"),
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
      verifiedAt: NOW,
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
