import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ImportArtifact, ImportSession, Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as P,
  ImportSessionErrorCode as Code,
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
  UiImportPersistenceGrantVerifier,
} from "./import-session.contract";
import { assertImportSessionOperationAvailable } from "./import-session.disabled";
import {
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

type Tx = Prisma.TransactionClient;
type Runtime = NonNullable<ReturnType<ImportVaultGate["boot"]["runtime"]>>;
const problem = (code: Code, row?: ImportSession) =>
  new ImportSessionError(
    code,
    row ? { sessionId: row.id, currentRevision: row.revision } : {},
  );

const HASH = new RegExp(P.hashPattern);

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
    const row = await loadOwnedImportSession(tx, actor, id);
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
    request: ImportSessionRevisionRequestV1,
    grant: unknown,
    signal?: AbortSignal,
  ): Promise<ImportSessionViewV1> {
    const rawDeadline = performance.now() + CSV_PARSER_DEADLINE_MS;
    const runtime = this.assertAvailable();
    assertMintedImportContext(auth);
    assertSessionId(sessionId);
    assertSessionId(attachmentId);
    const parsed = parseRevisionRequest(request);
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
        this.verifier.verify(
          grant,
          auth,
          {
            operation: "ANALYZE_ATTACHMENT",
            sessionId,
            attachmentId,
            expectedRevision: parsed.expectedRevision,
          },
          now,
        );
        spent = true;
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
        extraction = result.document;
        projectedArtifact = {
          ...capture.artifact,
          state: "EXTRACTED",
          parserVersion: extraction.parserVersion,
          extractionJson: canonical(extraction),
        };
      } else {
        extraction = readStoredImportExtraction(capture.artifact);
      }
      const plan = buildImportMaterialization({
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
      });
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
                ...(capture.kind === "RAW"
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
