import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ImportArtifact, ImportSession, Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as P,
  PDF_OCR_LIMITS,
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_DOCUMENT_VERSION,
  PDF_OCR_LEGACY_PARSER_VERSION,
  PDF_OCR_MODEL_ID,
  PDF_OCR_MODEL_VERSION_PATTERN,
  PDF_OCR_PARSER_VERSION,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_VERSION,
  ImportSessionErrorCode as Code,
  type PdfOcrDocumentV2,
  type PdfOcrProviderProvenanceV2,
  type PdfOcrUsageV2,
  type VertexAuthTraceV2,
  type ImportSessionRevisionRequestV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import { canonical } from "../../common/canonical";
import { assertMintedImportContext, reauthorize } from "./import-session.auth";
import {
  IMPORT_SESSION_CLOCK,
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_GRANT_VERIFIER,
  type ImportSessionClock,
  type ImportSessionCapability,
  importIntakeEnabled,
  importSessionWritesEnabled,
} from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportGrantScope,
  UiImportPersistenceGrantVerifier,
} from "./import-session.contract";
import { assertImportSessionOperationAvailable } from "./import-session.disabled";
import {
  INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT,
  ImportSessionError,
  ImportSessionCorruptStateError,
} from "./import-session.errors";
import {
  buildImportMaterialization,
  readStoredImportExtraction,
  supportsImportExtraction,
} from "./import-session.extraction";
import { effectiveState, parseStoredDraft } from "./import-session.projection";
import {
  assertSessionId,
  assertImportSessionAccess,
  canMutateImportSession,
  loadOwnedImportSession,
  parseRevisionRequest,
  renderImportSession,
} from "./import-session.service";
import { runImportSessionWrite } from "./import-session.writer";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault/vault-state";
import {
  ImportRawExecutions,
  CSV_PARSER_DEADLINE_MS,
  type ImportCsvSettlement,
  type ImportRawAdmission,
} from "./import-session.raw-executions";
import type { DocumentExtractionV1 } from "../../credit-card/parsers/types";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import { computeImportOrdinals } from "../../credit-card/parsers/dedupe-key";
import {
  PDF_OCR_PROVIDER,
  type FixedPdfOcrProviderPort,
} from "./ocr/pdf-ocr.ports";
import {
  isPdfOcrEnabled,
  isPdfOcrProjectConfigured,
} from "./ocr/pdf-ocr-capability";
import {
  PDF_OCR_CONSENT_DECISION,
  parseStoredPdfOcrState,
  pdfOcrRequestPayloadHash,
  serializePdfOcrState,
  type PdfOcrAnalyzeRequestV2,
} from "./ocr/pdf-ocr-state";
import {
  PDF_OCR_DISPATCH_STATE,
  PdfOcrProviderError,
} from "./ocr/vertex-pdf-ocr.provider";
import {
  newPdfOcrBudgetReservationId,
  PDF_OCR_USAGE_OUTCOME,
  reconcilePdfOcrBudget,
  reservePdfOcrBudget,
} from "./ocr/pdf-ocr-budget";
import { pdfOcrTerminalCodeForLedgerOutcome } from "./ocr/pdf-ocr-outcome";

type Tx = Prisma.TransactionClient;
type Runtime = NonNullable<ReturnType<ImportVaultGate["boot"]["runtime"]>>;
const problem = (
  code: Code | typeof INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT,
  row?: ImportSession,
) =>
  new ImportSessionError(
    code,
    row ? { sessionId: row.id, currentRevision: row.revision } : {},
  );
const ocrOutcomeProblem = (outcome: string, row: ImportSession) => {
  if (outcome === PDF_OCR_USAGE_OUTCOME.REQUEST_STALE_AFTER_COUNT)
    return problem(INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT, row);
  return problem(
    pdfOcrTerminalCodeForLedgerOutcome(outcome) ?? Code.OCR_ATTEMPT_UNKNOWN,
    row,
  );
};
type TerminalPdfOcrUsageOutcome = Exclude<
  (typeof PDF_OCR_USAGE_OUTCOME)[keyof typeof PDF_OCR_USAGE_OUTCOME],
  "ATTEMPTED" | "SUCCEEDED"
>;
const providerFailureOutcome = (
  error: PdfOcrProviderError,
): TerminalPdfOcrUsageOutcome => {
  if (
    error.failure === "LIMIT_EXCEEDED" ||
    error.failure === "INPUT_TOKEN_LIMIT_EXCEEDED"
  )
    return PDF_OCR_USAGE_OUTCOME.LIMIT_EXCEEDED;
  if (error.dispatchState === PDF_OCR_DISPATCH_STATE.NOT_DISPATCHED)
    return PDF_OCR_USAGE_OUTCOME.NOT_DISPATCHED;
  if (error.failure === "SAFETY") return PDF_OCR_USAGE_OUTCOME.SAFETY;
  if (error.failure === "MALFORMED_RESPONSE")
    return PDF_OCR_USAGE_OUTCOME.MALFORMED_RESPONSE;
  if (error.failure === "DOCUMENT_UNREADABLE")
    return PDF_OCR_USAGE_OUTCOME.DOCUMENT_UNREADABLE;
  return PDF_OCR_USAGE_OUTCOME.UNKNOWN;
};

const HASH = new RegExp(P.hashPattern);
const REQUEST_ID = new RegExp(P.requestIdPattern);
const V2_KEYS = [
  "version",
  "expectedRevision",
  "requestId",
  "consentExternalProcessing",
] as const;
export type AnalyzeAttachmentRequest =
  | ImportSessionRevisionRequestV1
  | PdfOcrAnalyzeRequestV2;

export function parseAnalyzeAttachmentRequest(
  body: unknown,
): AnalyzeAttachmentRequest {
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "version" in body
  ) {
    const value = body as Record<string, unknown>;
    if (
      Reflect.ownKeys(value).length !== V2_KEYS.length ||
      V2_KEYS.some(
        (key) => !Object.prototype.hasOwnProperty.call(value, key),
      ) ||
      value.version !== PDF_OCR_VERSION ||
      typeof value.requestId !== "string" ||
      !REQUEST_ID.test(value.requestId) ||
      value.consentExternalProcessing !== true
    )
      throw problem(Code.INVALID_INPUT);
    return {
      version: PDF_OCR_VERSION,
      ...parseRevisionRequest({ expectedRevision: value.expectedRevision }),
      requestId: value.requestId,
      consentExternalProcessing: true,
    };
  }
  return parseRevisionRequest(body);
}

function ocrExtraction(document: PdfOcrDocumentV2): DocumentExtractionV1 {
  const candidates = [...document.candidates];
  const ordinalInputs = candidates.flatMap((candidate, index) =>
    candidate.dateOnly === null ||
    candidate.description === null ||
    candidate.amountCents === null
      ? []
      : [
          {
            index,
            date: new Date(`${candidate.dateOnly}T00:00:00.000Z`),
            merchant: candidate.description,
            amountCents: Number(candidate.amountCents),
          },
        ],
  );
  const ordinals: Array<number | null> = candidates.map(() => null);
  computeImportOrdinals(ordinalInputs).forEach((ordinal, index) => {
    ordinals[ordinalInputs[index]!.index] = ordinal;
  });
  return {
    version: 1,
    parserVersion:
      document.version === PDF_OCR_VERSION
        ? PDF_OCR_LEGACY_PARSER_VERSION
        : PDF_OCR_PARSER_VERSION,
    documentKind: "INVOICE",
    invoiceDueMonth: null,
    metrics: {
      pages: document.pageCount,
      rows: candidates.length,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: candidates.map((candidate, sourceOrdinal) => ({
      reference: `ocr:page:${candidate.pageNumber}:candidate:${sourceOrdinal + 1}`,
      sourceOrdinal,
      section: "UNKNOWN",
      raw: {
        date: candidate.dateText,
        description: candidate.description,
        amount: candidate.amountCents,
        installment:
          candidate.installment === null
            ? null
            : `${candidate.installment.index}/${candidate.installment.total}`,
      },
      cycle: null,
      dateOnly: candidate.dateOnly,
      merchant: candidate.description,
      amountCents:
        candidate.amountCents === null ? null : Number(candidate.amountCents),
      amountMeaning: "UNKNOWN",
      installmentCount: candidate.installment?.total ?? null,
      installmentIndex: candidate.installment?.index ?? null,
      fitId: null,
      identityOrdinal: ordinals[sourceOrdinal]!,
    })),
    diagnostics: [],
  };
}

function boundOcrAuthTrace(
  document: PdfOcrDocumentV2,
  expected: Readonly<{
    artifactSha256: string;
    pageCount: number;
    requestId: string;
    provider: string;
    model: string;
  }>,
): VertexAuthTraceV2 {
  const provenance = document?.provenance;
  const trace = provenance?.requestTrace;
  const usage = provenance?.usage;
  const validCounter = (value: unknown): value is number =>
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= P.maxRevision;
  if (
    (document?.version !== PDF_OCR_VERSION &&
      document?.version !== PDF_OCR_DOCUMENT_VERSION) ||
    document.artifactSha256 !== expected.artifactSha256 ||
    document.pageCount !== expected.pageCount ||
    expected.provider !== PDF_OCR_PROVIDER_ID ||
    expected.model !== PDF_OCR_MODEL_ID ||
    provenance?.provider !== expected.provider ||
    provenance.model !== expected.model ||
    provenance.region !== PDF_OCR_REGION ||
    provenance.requestId !== expected.requestId ||
    typeof provenance.responseId !== "string" ||
    provenance.responseId.length < 1 ||
    provenance.responseId.length > P.maxReferenceLength ||
    typeof provenance.modelVersion !== "string" ||
    !new RegExp(PDF_OCR_MODEL_VERSION_PATTERN).test(provenance.modelVersion) ||
    !usage ||
    !validCounter(usage.inputTokens) ||
    !validCounter(usage.outputTokens) ||
    !validCounter(usage.totalTokens) ||
    usage.inputTokens + usage.outputTokens !== usage.totalTokens ||
    !trace ||
    trace.requestId !== expected.requestId ||
    trace.originalBytesSha256 !== expected.artifactSha256 ||
    (trace.authTrace !== "LOCAL_ADC" &&
      trace.authTrace !== "SERVICE_ACCOUNT_FILE_ADC")
  )
    throw new PdfOcrProviderError(
      "MALFORMED_RESPONSE",
      PDF_OCR_DISPATCH_STATE.DISPATCHED_OR_UNKNOWN,
    );
  return trace.authTrace;
}

@Injectable()
export class ImportSessionExtractionService {
  private readonly logger = new Logger("ImportSessionExtraction");
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
    @Inject(IMPORT_SESSION_CAPABILITY)
    private readonly capability: ImportSessionCapability,
    @Inject(IMPORT_SESSION_GRANT_VERIFIER)
    private readonly verifier: UiImportPersistenceGrantVerifier,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
    private readonly raw: ImportRawExecutions,
    @Optional()
    @Inject(PDF_OCR_PROVIDER)
    private readonly ocrProvider?: FixedPdfOcrProviderPort,
  ) {}

  assertAvailable(): Runtime {
    assertImportSessionOperationAvailable(
      "ANALYZE",
      importIntakeEnabled(this.capability),
    );
    const runtime = this.gate.boot.runtime();
    if (!runtime || this.gate.boot.stopped.aborted)
      throw problem(Code.CAPABILITY_DISABLED);
    return runtime;
  }
  private current(runtime: Runtime, signal?: AbortSignal): undefined {
    if (this.assertAvailable() !== runtime)
      throw problem(Code.CAPABILITY_DISABLED);
    if (signal?.aborted) throw problem(Code.LEASE_CONFLICT);
    return undefined;
  }
  private async authorized(
    tx: Tx,
    auth: AuthenticatedImportContext,
    id: string,
    now: Date,
  ) {
    const actor = await reauthorize(tx, auth, now);
    const row = await loadOwnedImportSession(tx, actor, id, now);
    await assertImportSessionAccess(tx, actor, row, now);
    if (effectiveState(row, now) === "EXPIRED")
      throw problem(Code.SESSION_EXPIRED, row);
    if (row.state === "APPLIED") throw problem(Code.ALREADY_APPLIED, row);
    if (
      !["DRAFT", "NEEDS_INPUT", "READY", "REVIEW_REQUIRED"].includes(
        row.state,
      ) ||
      row.closedAt !== null ||
      row.financialRequestId !== null
    )
      throw problem(Code.STALE_PREVIEW, row);
    if (
      row.consentPolicyVersion !== IMPORT_SESSION_CONSENT_POLICY_VERSION ||
      !Number.isFinite(row.consentedAt.getTime())
    )
      throw new ImportSessionCorruptStateError("consent");
    return row;
  }
  private async material(tx: Tx, row: ImportSession, attachmentId: string) {
    const ref = await tx.importSessionArtifact.findFirst({
      where: {
        id: attachmentId,
        sessionId: row.id,
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
      },
    });
    if (!ref) throw problem(Code.NOT_FOUND);
    if (ref.state !== "ATTACHED" || ref.artifactId === null)
      throw problem(Code.LEASE_CONFLICT);
    const artifact = await tx.importArtifact.findFirst({
      where: {
        id: ref.artifactId,
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
      },
    });
    if (!artifact) throw problem(Code.NOT_FOUND);
    if (artifact.documentSha256 === null)
      throw problem(Code.STALE_PREVIEW, row);
    return { ref, artifact };
  }
  private observations(tx: Tx, row: ImportSession, artifactId: string) {
    return tx.importObservation.findMany({
      where: {
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        artifactId,
      },
      orderBy: { id: "asc" },
      take: LIMITS.parsedRowsPerSession + 1,
    });
  }
  async analyzeGrantScope(
    auth: AuthenticatedImportContext,
    sessionId: string,
    attachmentId: string,
    request: AnalyzeAttachmentRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<UiImportGrantScope> {
    this.assertAvailable();
    assertMintedImportContext(auth);
    assertSessionId(sessionId);
    assertSessionId(attachmentId);
    const parsed = parseAnalyzeAttachmentRequest(request);
    const live = () => {
      if (signal.aborted) throw problem(Code.OCR_UNAVAILABLE);
    };
    live();
    if (
      "version" in parsed &&
      (!this.ocrProvider?.ready() ||
        !isPdfOcrProjectConfigured(process.env) ||
        !isPdfOcrEnabled(process.env, {
          providerReady: true,
          consentV2Ready: true,
          vaultReady:
            !this.gate.boot.stopped.aborted &&
            this.gate.boot.runtime() !== null,
        }))
    )
      throw problem(Code.OCR_UNAVAILABLE);
    return await this.prisma.$transaction(async (tx) => {
      live();
      const row = await this.authorized(tx, auth, sessionId, this.clock.now());
      live();
      if (row.revision !== parsed.expectedRevision)
        throw problem(Code.REVISION_CONFLICT, row);
      const { artifact } = await this.material(tx, row, attachmentId);
      live();
      if (!("version" in parsed))
        return {
          operation: "ANALYZE_ATTACHMENT" as const,
          sessionId,
          attachmentId,
          expectedRevision: parsed.expectedRevision,
        };
      const consent = parseStoredPdfOcrState(row.ocrJson).consents.find(
        (item) => item.attachmentId === attachmentId,
      );
      const requestPayloadHash = pdfOcrRequestPayloadHash(parsed);
      if (
        !consent ||
        consent.usageId !== null ||
        consent.actorId !== auth.userId ||
        consent.artifactSha256 !== artifact.documentSha256 ||
        consent.requestId !== parsed.requestId ||
        consent.expectedRevision !== parsed.expectedRevision ||
        consent.requestPayloadHash !== requestPayloadHash ||
        consent.consentPolicyVersion !== PDF_OCR_CONSENT_POLICY_VERSION ||
        consent.consentDecision !== PDF_OCR_CONSENT_DECISION
      )
        throw problem(Code.UI_ACTION_REQUIRED, row);
      return {
        operation: "ANALYZE_ATTACHMENT_V2" as const,
        sessionId,
        attachmentId,
        expectedRevision: parsed.expectedRevision,
        actorId: auth.userId,
        artifactSha256: artifact.documentSha256!,
        consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
        requestId: parsed.requestId,
        requestPayloadHash,
        decision: PDF_OCR_CONSENT_DECISION,
      };
    });
  }
  private async view(
    tx: Tx,
    row: ImportSession,
    auth: AuthenticatedImportContext,
    now: Date,
  ) {
    const actor = await reauthorize(tx, auth, now);
    const canMutate = await canMutateImportSession(
      tx,
      actor,
      row.ownerProjectId,
    );
    return (
      await renderImportSession(tx, row, now, {
        includeReceipt: true,
        analysisEnabled: true,
        qualifiedAnalysisFormats: this.capability.newImportFormats(),
        workflow: {
          writesEnabled: await importSessionWritesEnabled(
            tx,
            row,
            this.capability,
          ),
          canMutate,
          presentedSessionVersion: auth.presentedSessionVersion,
        },
      })
    ).view;
  }
  async analyzeAttached(
    auth: AuthenticatedImportContext,
    sessionId: string,
    attachmentId: string,
    request: AnalyzeAttachmentRequest,
    grant: unknown,
    signal?: AbortSignal,
  ): Promise<ImportSessionViewV1> {
    const rawDeadline = performance.now() + CSV_PARSER_DEADLINE_MS;
    const runtime = this.assertAvailable();
    assertMintedImportContext(auth);
    assertSessionId(sessionId);
    assertSessionId(attachmentId);
    const parsed = parseAnalyzeAttachmentRequest(request);
    const ocrRequest =
      "version" in parsed && parsed.version === PDF_OCR_VERSION
        ? parsed
        : undefined;
    let spent = false;
    const live = (): undefined => {
      this.current(runtime, signal);
      if (this.clock.now().getTime() >= Date.parse(auth.tokenExpiresAt))
        throw problem(Code.UNAUTHENTICATED);
      return undefined;
    };
    let phaseLive = live;
    const write = <T>(work: (tx: Tx, now: Date) => Promise<T>) =>
      runImportSessionWrite(
        this.prisma,
        this.clock,
        auth,
        async (tx, now) => {
          phaseLive();
          const result = await work(tx, now);
          phaseLive();
          return result;
        },
        () => phaseLive(),
      );
    const admitted = await write(async (tx, now) => {
      const row = await this.authorized(tx, auth, sessionId, now);
      const { ref, artifact } = await this.material(tx, row, attachmentId);
      const draft = parseStoredDraft(row.draftJson);
      if (!spent) {
        const grantScope: UiImportGrantScope = ocrRequest
          ? {
              operation: "ANALYZE_ATTACHMENT_V2",
              sessionId,
              attachmentId,
              expectedRevision: parsed.expectedRevision,
              actorId: auth.userId,
              artifactSha256: artifact.documentSha256!,
              consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
              requestId: ocrRequest.requestId,
              requestPayloadHash: pdfOcrRequestPayloadHash(ocrRequest),
              decision: PDF_OCR_CONSENT_DECISION,
            }
          : {
              operation: "ANALYZE_ATTACHMENT",
              sessionId,
              attachmentId,
              expectedRevision: parsed.expectedRevision,
            };
        this.verifier.verify(grant, auth, grantScope, now);
        spent = true;
      }
      if (ocrRequest) {
        const state = parseStoredPdfOcrState(row.ocrJson);
        const consent = state.consents.find(
          (item) => item.attachmentId === ref.id,
        );
        if (consent?.usageId) {
          const requestHash = pdfOcrRequestPayloadHash(ocrRequest);
          if (
            consent.requestId !== ocrRequest.requestId ||
            consent.requestPayloadHash !== requestHash ||
            consent.actorId !== auth.userId ||
            consent.artifactSha256 !== artifact.documentSha256
          )
            throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          const usage = await tx.importOcrUsage.findUnique({
            where: { id: consent.usageId },
          });
          if (
            !usage ||
            usage.tenantId !== row.tenantId ||
            usage.ownerProjectId !== row.ownerProjectId ||
            usage.actorId !== auth.userId ||
            usage.sessionId !== row.id ||
            usage.attachmentId !== ref.id ||
            usage.artifactId !== artifact.id ||
            usage.artifactSha256 !== artifact.documentSha256 ||
            usage.requestId !== ocrRequest.requestId
          )
            throw problem(Code.OCR_ATTEMPT_UNKNOWN, row);
          if (usage.outcome === PDF_OCR_USAGE_OUTCOME.SUCCEEDED)
            return {
              kind: "REPLAY" as const,
              view: await this.view(tx, row, auth, now),
            };
          throw ocrOutcomeProblem(usage.outcome, row);
        }
      }
      if (!draft.scope.pendingAttachmentIds.includes(ref.id))
        return {
          kind: "REPLAY" as const,
          view: await this.view(tx, row, auth, now),
        };
      if (row.revision !== parsed.expectedRevision)
        throw problem(Code.REVISION_CONFLICT, row);
      // This applies to cached EXTRACTED adoption as well as first RAW extraction.
      // Completed materializations returned above remain read-only replays.
      if (
        (artifact.detectedFormat !== "CSV" &&
          artifact.detectedFormat !== "PDF") ||
        !this.capability.newImportFormats().includes(artifact.detectedFormat)
      )
        throw problem(Code.UNSUPPORTED_DOCUMENT);
      const raw =
        artifact.state === "RAW_READY" || artifact.state === "ANALYZING";
      if (raw) {
        this.raw.assertAvailable(artifact.detectedFormat);
        if (performance.now() >= rawDeadline)
          throw problem(Code.LIMIT_EXCEEDED);
        if (
          !artifact.storageKey ||
          typeof artifact.documentSha256 !== "string" ||
          !HASH.test(artifact.documentSha256) ||
          !Number.isSafeInteger(artifact.verifiedBytes) ||
          artifact.verifiedBytes <= 0
        )
          throw problem(Code.INVALID_INPUT);
        if (artifact.verifiedBytes > LIMITS.bytesPerFile)
          throw problem(Code.LIMIT_EXCEEDED);
      } else {
        if (
          artifact.state !== "EXTRACTED" ||
          !supportsImportExtraction(artifact)
        )
          throw problem(Code.CAPABILITY_DISABLED);
        if (artifact.extractionJson === null)
          throw new ImportSessionCorruptStateError("extraction_json");
      }
      if (artifact.parseGeneration >= P.maxRevision)
        throw problem(Code.LIMIT_EXCEEDED, row);
      if (artifact.leaseExpiresAt !== null && artifact.leaseExpiresAt > now)
        throw problem(Code.LEASE_CONFLICT);
      const deadline = new Date(
        Math.min(
          now.getTime() + LIMITS.parserLeaseSeconds * 1000,
          row.expiresAt.getTime(),
          Date.parse(auth.tokenExpiresAt),
        ),
      );
      const lease: Pick<
        ImportArtifact,
        | "parseGeneration"
        | "leaseSessionId"
        | "leaseSessionVersion"
        | "leaseTokenExpiresAt"
        | "leaseExpiresAt"
      > = {
        parseGeneration: artifact.parseGeneration + 1,
        leaseSessionId: row.id,
        leaseSessionVersion: auth.presentedSessionVersion,
        leaseTokenExpiresAt: new Date(auth.tokenExpiresAt),
        leaseExpiresAt: deadline,
      };
      this.current(runtime, signal);
      const changed = await tx.importArtifact.updateMany({
        where: {
          id: artifact.id,
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
          state: artifact.state,
          parseGeneration: artifact.parseGeneration,
          leaseSessionId: artifact.leaseSessionId,
          leaseExpiresAt: artifact.leaseExpiresAt,
        },
        data: { ...lease, ...(raw ? { state: "ANALYZING" } : {}) },
      });
      if (changed.count !== 1) throw problem(Code.LEASE_CONFLICT);
      const observations = await this.observations(tx, row, artifact.id);
      return {
        kind: raw ? ("RAW" as const) : ("ADOPT" as const),
        row,
        ref,
        draft,
        artifact: {
          ...artifact,
          ...lease,
          state: raw ? ("ANALYZING" as const) : ("EXTRACTED" as const),
        },
        observations,
      };
    });
    if (admitted.kind === "REPLAY") return admitted.view;
    const capture = admitted;
    const leaseWhere = {
      id: capture.artifact.id,
      tenantId: auth.tenantId,
      ownerProjectId: capture.row.ownerProjectId,
      parseGeneration: capture.artifact.parseGeneration,
      leaseSessionId: sessionId,
      leaseSessionVersion: capture.artifact.leaseSessionVersion,
      leaseTokenExpiresAt: capture.artifact.leaseTokenExpiresAt,
      leaseExpiresAt: capture.artifact.leaseExpiresAt,
      state: capture.artifact.state,
    };
    const release = {
      leaseSessionId: null,
      leaseSessionVersion: null,
      leaseTokenExpiresAt: null,
      leaseExpiresAt: null,
    };
    let admission: ImportRawAdmission | undefined;
    let started = false;
    let settlement: ImportCsvSettlement | undefined;
    let ocrAttempted = false;
    let ocrBudgetReservationId: string | null = null;
    let ocrFailureOutcome: TerminalPdfOcrUsageOutcome | null = null;
    let ocrFailureProvenance: PdfOcrProviderProvenanceV2 | null = null;
    let ocrFailureUsage: PdfOcrUsageV2 | null = null;
    let ocrDocument: PdfOcrDocumentV2 | null = null;
    let ocrAuthTrace: VertexAuthTraceV2 | null = null;
    const publicationLive = (): undefined => {
      live();
      if (
        (capture.artifact.detectedFormat !== "CSV" &&
          capture.artifact.detectedFormat !== "PDF") ||
        !this.capability
          .newImportFormats()
          .includes(capture.artifact.detectedFormat)
      )
        throw problem(Code.UNSUPPORTED_DOCUMENT);
      const now = this.clock.now();
      if (now >= capture.row.expiresAt)
        throw problem(Code.SESSION_EXPIRED, capture.row);
      if (
        capture.artifact.leaseExpiresAt === null ||
        now >= capture.artifact.leaseExpiresAt
      )
        throw problem(Code.LEASE_CONFLICT);
      if (admission) this.raw.assertLive(admission);
      else if (capture.kind === "RAW" && performance.now() >= rawDeadline)
        throw problem(Code.LIMIT_EXCEEDED);
      return undefined;
    };
    phaseLive = publicationLive;
    const recheck = async (tx: Tx, now: Date) => {
      publicationLive();
      const row = await this.authorized(tx, auth, sessionId, now);
      publicationLive();
      const { ref, artifact } = await this.material(tx, row, attachmentId);
      publicationLive();
      if (
        row.revision !== capture.row.revision ||
        row.draftJson !== capture.row.draftJson
      )
        throw problem(Code.REVISION_CONFLICT, row);
      if (
        canonical(ref) !== canonical(capture.ref) ||
        artifact.parseGeneration !== capture.artifact.parseGeneration ||
        artifact.leaseSessionId !== row.id ||
        artifact.leaseSessionVersion !== auth.presentedSessionVersion ||
        artifact.leaseTokenExpiresAt?.getTime() !==
          capture.artifact.leaseTokenExpiresAt?.getTime() ||
        artifact.leaseExpiresAt?.getTime() !==
          capture.artifact.leaseExpiresAt?.getTime() ||
        artifact.leaseExpiresAt === null ||
        artifact.leaseExpiresAt <= now ||
        artifact.state !== capture.artifact.state ||
        artifact.storageKey !== capture.artifact.storageKey ||
        artifact.documentSha256 !== capture.artifact.documentSha256 ||
        artifact.verifiedBytes !== capture.artifact.verifiedBytes ||
        artifact.detectedFormat !== capture.artifact.detectedFormat ||
        artifact.parserVersion !== capture.artifact.parserVersion ||
        artifact.extractionJson !== capture.artifact.extractionJson
      )
        throw problem(Code.LEASE_CONFLICT);
      if (
        canonical(await this.observations(tx, row, artifact.id)) !==
        canonical(capture.observations)
      )
        throw problem(Code.STALE_PREVIEW, row);
      publicationLive();
      return row;
    };
    try {
      publicationLive();
      let extraction: DocumentExtractionV1;
      let projectedArtifact = capture.artifact;
      if (capture.kind === "RAW") {
        admission = this.raw.admit({
          ...(capture.artifact.detectedFormat === "CSV" ||
          capture.artifact.detectedFormat === "PDF"
            ? { documentFormat: capture.artifact.detectedFormat }
            : {}),
          claim: {
            tenantId: auth.tenantId,
            ownerProjectId: capture.row.ownerProjectId,
            sessionId,
            artifactId: capture.artifact.id,
            parseGeneration: capture.artifact.parseGeneration,
          },
          ownerUserId: auth.userId,
          runtime,
          requestSignal: signal,
          deadlineMonotonicMs: rawDeadline,
          leaseExpiresAtMs: capture.artifact.leaseExpiresAt!.getTime(),
        });
        const authorizedReader = async () => {
          publicationLive();
          const proof = await this.gate.boot.recheckLock();
          publicationLive();
          if (!proof.ok || proof.runtime !== runtime)
            throw problem(Code.CAPABILITY_DISABLED);
          await write(recheck);
          publicationLive();
        };
        await authorizedReader();
        const rawSignal = admission.signal;
        const bytes = await this.gate.storage.withArtifactReader(
          {
            tenantId: auth.tenantId,
            ownerProjectId: capture.row.ownerProjectId,
            ownerUserId: auth.userId,
            sessionId,
            refId: capture.ref.id,
            artifactId: capture.artifact.id,
            storageKey: capture.artifact.storageKey!,
          },
          authorizedReader,
          async (source) => {
            const bytes = Buffer.alloc(capture.artifact.verifiedBytes);
            const sha = createHash("sha256");
            let used = 0;
            const abort = () => source.destroy(problem(Code.LEASE_CONFLICT));
            rawSignal.addEventListener("abort", abort, { once: true });
            if (rawSignal.aborted) abort();
            try {
              for await (const chunk of source) {
                publicationLive();
                if (!Buffer.isBuffer(chunk)) throw problem(Code.INVALID_INPUT);
                if (used + chunk.length > bytes.length)
                  throw problem(Code.LIMIT_EXCEEDED);
                chunk.copy(bytes, used);
                used += chunk.length;
                sha.update(chunk);
              }
              publicationLive();
              if (
                used !== bytes.length ||
                sha.digest("hex") !== capture.artifact.documentSha256
              )
                throw problem(Code.INVALID_INPUT);
              return bytes;
            } finally {
              rawSignal.removeEventListener("abort", abort);
            }
          },
        );
        await authorizedReader();
        publicationLive();
        started = true;
        const handle =
          capture.artifact.detectedFormat === "PDF"
            ? this.raw.startPdf(admission, bytes)
            : this.raw.startCsv(admission, bytes);
        void handle.settled.then(
          (value) => {
            settlement = value;
          },
          (error: unknown) =>
            this.logger.error({
              event: "raw_settlement_failed",
              errorClass: error instanceof Error ? error.name : "Unknown",
            }),
        );
        let result: Awaited<typeof handle.result>;
        try {
          result = await handle.result;
        } finally {
          settlement = await handle.settled;
        }
        publicationLive();
        settlement = await handle.settled;
        publicationLive();
        if (settlement.cleanup !== "CLEAN")
          throw problem(Code.CAPABILITY_DISABLED);
        if (result.kind === "OCR_ELIGIBLE") {
          if (!ocrRequest) throw problem(Code.OCR_REQUIRED, capture.row);
          if (
            !this.ocrProvider?.ready() ||
            !isPdfOcrEnabled(process.env, {
              providerReady: true,
              consentV2Ready: true,
              vaultReady:
                !this.gate.boot.stopped.aborted &&
                this.gate.boot.runtime() !== null,
            }) ||
            result.pageCount < 1 ||
            result.pageCount > PDF_OCR_LIMITS.pagesPerFile
          )
            throw problem(
              result.pageCount > PDF_OCR_LIMITS.pagesPerFile
                ? Code.LIMIT_EXCEEDED
                : Code.OCR_UNAVAILABLE,
              capture.row,
            );
          const requestHash = pdfOcrRequestPayloadHash(ocrRequest);
          const budgetReservationId = newPdfOcrBudgetReservationId();
          const attempt = await write(async (tx, now) => {
            const row = await recheck(tx, now);
            const state = parseStoredPdfOcrState(row.ocrJson);
            const consent = state.consents.find(
              (item) => item.attachmentId === capture.ref.id,
            );
            if (
              !consent ||
              consent.usageId !== null ||
              consent.requestId !== ocrRequest.requestId ||
              consent.requestPayloadHash !== requestHash ||
              consent.expectedRevision !== row.revision ||
              consent.actorId !== auth.userId ||
              consent.artifactSha256 !== capture.artifact.documentSha256
            )
              throw problem(Code.IDEMPOTENCY_CONFLICT, row);
            const ocrJson = serializePdfOcrState({
              version: PDF_OCR_VERSION,
              consents: state.consents.map((item) =>
                item.attachmentId === capture.ref.id
                  ? { ...item, usageId: budgetReservationId }
                  : item,
              ),
            });
            try {
              await reservePdfOcrBudget(tx, {
                id: budgetReservationId,
                tenantId: row.tenantId,
                ownerProjectId: row.ownerProjectId,
                actorId: auth.userId,
                sessionId: row.id,
                attachmentId: capture.ref.id,
                artifactId: capture.artifact.id,
                artifactSha256: capture.artifact.documentSha256!,
                requestId: ocrRequest.requestId,
                pageCount: result.pageCount,
                byteCount: bytes.length,
                now,
              });
            } catch (error) {
              if (
                error instanceof ImportSessionError &&
                error.code === Code.OCR_BUDGET_EXHAUSTED
              )
                this.logger.warn({
                  event: "import_ocr_budget_exhausted",
                  tenantId: row.tenantId,
                  actorId: auth.userId,
                });
              throw error;
            }
            const changed = await tx.importSession.updateMany({
              where: {
                id: row.id,
                tenantId: row.tenantId,
                ownerProjectId: row.ownerProjectId,
                ownerUserId: row.ownerUserId,
                revision: row.revision,
                ocrJson: row.ocrJson,
                closedAt: null,
                financialRequestId: null,
              },
              data: { ocrJson },
            });
            if (changed.count !== 1) throw problem(Code.LEASE_CONFLICT, row);
            return consent;
          });
          ocrBudgetReservationId = budgetReservationId;
          ocrAttempted = true;
          try {
            const providerRequest = {
              artifactSha256: attempt.artifactSha256,
              pageCount: result.pageCount,
              requestId: attempt.requestId,
              pdfBytes: bytes,
              signal: rawSignal,
            };
            const providerHooks = {
              beforeGeneration: async (providerSignal: AbortSignal) => {
                try {
                  if (providerSignal.aborted)
                    throw problem(INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT);
                  await write(async (tx, now) => {
                    const row = await recheck(tx, now);
                    const state = parseStoredPdfOcrState(row.ocrJson);
                    const consent = state.consents.find(
                      (item) => item.attachmentId === capture.ref.id,
                    );
                    if (
                      !consent ||
                      consent.usageId !== budgetReservationId ||
                      consent.requestId !== attempt.requestId ||
                      consent.actorId !== auth.userId ||
                      consent.artifactSha256 !== attempt.artifactSha256
                    )
                      throw problem(
                        INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT,
                        row,
                      );
                    const usage = await tx.importOcrUsage.findUnique({
                      where: { id: budgetReservationId },
                    });
                    if (
                      !usage ||
                      usage.tenantId !== row.tenantId ||
                      usage.ownerProjectId !== row.ownerProjectId ||
                      usage.actorId !== auth.userId ||
                      usage.sessionId !== row.id ||
                      usage.attachmentId !== capture.ref.id ||
                      usage.artifactId !== capture.artifact.id ||
                      usage.artifactSha256 !== attempt.artifactSha256 ||
                      usage.requestId !== attempt.requestId ||
                      usage.outcome !== PDF_OCR_USAGE_OUTCOME.ATTEMPTED ||
                      !this.ocrProvider?.ready()
                    )
                      throw problem(
                        INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT,
                        row,
                      );
                  });
                } catch {
                  throw problem(
                    INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT,
                    capture.row,
                  );
                }
              },
            };
            const document =
              this.ocrProvider.extractPdf.length >= 2
                ? await this.ocrProvider.extractPdf(
                    providerRequest,
                    providerHooks,
                  )
                : await this.ocrProvider.extractPdf(providerRequest);
            publicationLive();
            ocrAuthTrace = boundOcrAuthTrace(document, {
              artifactSha256: attempt.artifactSha256,
              pageCount: result.pageCount,
              requestId: attempt.requestId,
              provider: this.ocrProvider.provider,
              model: this.ocrProvider.model,
            });
            ocrDocument = document;
            try {
              extraction = validateDocumentExtraction(ocrExtraction(document));
            } catch {
              throw new PdfOcrProviderError(
                "MALFORMED_RESPONSE",
                PDF_OCR_DISPATCH_STATE.DISPATCHED_OR_UNKNOWN,
              );
            }
          } catch (error) {
            if (
              error instanceof ImportSessionError &&
              error.code === INTERNAL_OCR_REQUEST_STALE_AFTER_COUNT
            ) {
              ocrFailureOutcome =
                PDF_OCR_USAGE_OUTCOME.REQUEST_STALE_AFTER_COUNT;
              throw error;
            }
            ocrFailureOutcome =
              error instanceof PdfOcrProviderError
                ? providerFailureOutcome(error)
                : PDF_OCR_USAGE_OUTCOME.UNKNOWN;
            ocrFailureProvenance =
              error instanceof PdfOcrProviderError
                ? (error.provenance ?? null)
                : null;
            ocrFailureUsage =
              error instanceof PdfOcrProviderError
                ? (error.usage ?? null)
                : null;
            if (ocrAttempted)
              throw ocrOutcomeProblem(ocrFailureOutcome, capture.row);
            throw error;
          }
        } else {
          extraction = result.document;
        }
        projectedArtifact = {
          ...capture.artifact,
          state: "EXTRACTED",
          parserVersion: extraction.parserVersion,
          extractionJson: canonical(extraction),
        };
      } else {
        extraction = readStoredImportExtraction(capture.artifact);
      }
      let plan: ReturnType<typeof buildImportMaterialization>;
      try {
        plan = buildImportMaterialization({
          session: capture.row,
          attachment: capture.ref,
          artifact: projectedArtifact,
          extraction,
          draft: capture.draft,
          observations: capture.observations,
          newIds: new Map(
            extraction.occurrences.map((o) => [
              o.reference,
              { observationId: randomUUID(), lineId: randomUUID() },
            ]),
          ),
          ocr:
            ocrDocument && ocrBudgetReservationId && ocrAuthTrace
              ? {
                  usageId: ocrBudgetReservationId,
                  document: ocrDocument,
                  authTrace: ocrAuthTrace,
                }
              : null,
        });
      } catch (error) {
        if (!ocrDocument) throw error;
        ocrFailureOutcome = PDF_OCR_USAGE_OUTCOME.MALFORMED_RESPONSE;
        throw problem(Code.OCR_MALFORMED_RESPONSE, capture.row);
      }
      return await write(async (tx, now) => {
        const row = await recheck(tx, now);
        const attached = await tx.importSessionArtifact.findMany({
          where: {
            sessionId: row.id,
            tenantId: row.tenantId,
            state: "ATTACHED",
          },
          include: { artifact: true },
        });
        let totalPages = extraction.metrics.pages;
        for (const ref of attached) {
          if (
            ref.artifact &&
            ref.artifact.id !== capture.artifact.id &&
            ref.artifact.state === "EXTRACTED" &&
            ref.artifact.detectedFormat === "PDF"
          )
            totalPages += readStoredImportExtraction(ref.artifact).metrics
              .pages;
        }
        if (totalPages > LIMITS.pdfPagesPerSession)
          throw problem(Code.LIMIT_EXCEEDED);
        if (row.revision >= P.maxRevision)
          throw problem(Code.LIMIT_EXCEEDED, row);
        if (ocrDocument) {
          if (ocrBudgetReservationId === null)
            throw problem(Code.OCR_ATTEMPT_UNKNOWN, row);
          await reconcilePdfOcrBudget(
            tx,
            ocrBudgetReservationId,
            PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
            now,
            ocrDocument.provenance.usage,
            ocrDocument.provenance.responseId,
            ocrDocument.provenance,
          );
        }
        for (const observation of plan.observations) {
          publicationLive();
          await tx.importObservation.create({ data: observation });
        }
        publicationLive();
        const changed = await tx.importSession.updateMany({
          where: {
            id: row.id,
            tenantId: auth.tenantId,
            ownerUserId: auth.userId,
            revision: row.revision,
            financialRequestId: null,
            closedAt: null,
          },
          data: {
            draftJson: canonical(plan.draft),
            revision: { increment: 1 },
            state: plan.draft.questions.length ? "NEEDS_INPUT" : "DRAFT",
            searchJson: null,
            proposalJson: null,
            proposalHash: null,
            preflightHash: null,
            challengeJson: null,
            prepareLeaseJson: null,
            prepareGeneration: { increment: 1 },
            ocrJson: row.ocrJson,
          },
        });
        if (changed.count !== 1) throw problem(Code.REVISION_CONFLICT, row);
        publicationLive();
        if (
          (
            await tx.importArtifact.updateMany({
              where: leaseWhere,
              data: {
                ...release,
                ...(ocrDocument
                  ? {
                      state: "EXTRACTED",
                      parserVersion: projectedArtifact.parserVersion,
                      extractionJson: projectedArtifact.extractionJson,
                    }
                  : capture.kind === "RAW"
                    ? {
                        state: "EXTRACTED",
                        parserVersion: projectedArtifact.parserVersion,
                        extractionJson: projectedArtifact.extractionJson,
                      }
                    : {}),
              },
            })
          ).count !== 1
        )
          throw problem(Code.LEASE_CONFLICT);
        const view = await this.view(
          tx,
          await this.authorized(tx, auth, sessionId, now),
          auth,
          now,
        );
        publicationLive();
        return view;
      });
    } catch (error) {
      if (ocrAttempted) {
        try {
          await runImportSessionWrite(
            this.prisma,
            this.clock,
            auth,
            async (tx, now) => {
              if (ocrBudgetReservationId === null)
                throw problem(Code.OCR_ATTEMPT_UNKNOWN, capture.row);
              await reconcilePdfOcrBudget(
                tx,
                ocrBudgetReservationId,
                ocrFailureOutcome ?? PDF_OCR_USAGE_OUTCOME.UNKNOWN,
                now,
                ocrFailureUsage ?? ocrFailureProvenance?.usage ?? null,
                ocrFailureProvenance?.responseId ?? null,
                ocrFailureProvenance,
              );
            },
          );
        } catch (reconciliationError) {
          this.logger.error({
            event: "import_ocr_reconciliation_failed",
            errorClass:
              reconciliationError instanceof Error
                ? reconciliationError.name
                : "Unknown",
          });
        }
      }
      if (
        !this.gate.boot.stopped.aborted &&
        this.gate.boot.runtime() === runtime &&
        (!started || settlement?.cleanup === "CLEAN")
      ) {
        try {
          await runImportSessionWrite(
            this.prisma,
            this.clock,
            auth,
            async (tx) => {
              this.current(runtime);
              await tx.importArtifact.updateMany({
                where: leaseWhere,
                data: {
                  ...release,
                  ...(capture.kind === "RAW" ? { state: "RAW_READY" } : {}),
                },
              });
              this.current(runtime);
            },
            () => this.current(runtime),
          );
        } catch (cleanupError) {
          this.logger.error({
            event: "import_adoption_cleanup_failed",
            errorClass:
              cleanupError instanceof Error ? cleanupError.name : "Unknown",
          });
        }
      }
      throw error;
    } finally {
      if (admission) this.raw.close(admission);
    }
  }
}
