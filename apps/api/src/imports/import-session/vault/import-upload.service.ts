import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  Prisma,
  type ImportSession,
  type ImportSessionArtifact,
} from "@prisma/client";
import type { Readable } from "node:stream";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionErrorCode,
  ImportSessionState,
  ImportSessionArtifactState,
  ImportSessionAttachmentState,
  type ImportSessionUploadResponseV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { assertMintedImportContext, reauthorize } from "../import-session.auth";
import {
  IMPORT_SESSION_CLOCK,
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_GRANT_VERIFIER,
  type ImportSessionClock,
  type ImportSessionCapability,
  importIntakeEnabled,
  importSessionWritesEnabled,
} from "../import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportPersistenceGrantVerifier,
} from "../import-session.contract";
import { assertImportSessionOperationAvailable } from "../import-session.disabled";
import { ImportSessionError } from "../import-session.errors";
import {
  assertSessionId,
  assertImportSessionAccess,
  canMutateImportSession,
  loadOwnedImportSession,
  renderImportSession,
} from "../import-session.service";
import {
  effectiveState,
  IMPORT_SESSION_UPLOAD_EDITABLE_STATES,
} from "../import-session.projection";
import { runImportSessionWrite } from "../import-session.writer";
import { canonical } from "../../../common/canonical";
import { parseStoredDraft } from "../import-session.projection";
import { validateStoredDraft } from "../import-session.validation";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault-state";
import {
  MIME_FORMAT,
  VaultIoError,
  type VaultDeclaredMime,
  type VaultUploadClaim,
  type StoredVaultUpload,
} from "./vault-storage";

type Tx = Prisma.TransactionClient;
type Runtime = NonNullable<ReturnType<ImportVaultGate["boot"]["runtime"]>>;
type Reserve = Readonly<{
  expectedRevision: number;
  files: readonly Readonly<{
    id: string;
    fileName: string;
    declaredBytes: number;
    mime: VaultDeclaredMime;
  }>[];
}>;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const error = (code: ImportSessionErrorCode) => new ImportSessionError(code);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const mime = (value: unknown): value is VaultDeclaredMime =>
  typeof value === "string" &&
  Object.prototype.hasOwnProperty.call(MIME_FORMAT, value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

export function parseReserveRequest(body: unknown): Reserve {
  if (
    !record(body) ||
    !exact(body, ["expectedRevision", "files"]) ||
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1 ||
    body.expectedRevision > IMPORT_SESSION_PRIMITIVES.maxRevision ||
    !Array.isArray(body.files) ||
    body.files.length === 0
  )
    throw error(ImportSessionErrorCode.INVALID_INPUT);
  if (body.files.length > IMPORT_SESSION_LIMITS.filesPerRequest)
    throw error(ImportSessionErrorCode.LIMIT_EXCEEDED);
  const ids = new Set<string>();
  const files = body.files.map((file: unknown) => {
    if (
      !record(file) ||
      !exact(file, ["id", "fileName", "declaredBytes", "mime"]) ||
      typeof file.id !== "string" ||
      !UUID.test(file.id) ||
      ids.has(file.id) ||
      typeof file.fileName !== "string" ||
      file.fileName !== file.fileName.normalize("NFC") ||
      [...file.fileName].length < 1 ||
      [...file.fileName].length > 255 ||
      file.fileName.trim() !== file.fileName ||
      [".", ".."].includes(file.fileName) ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]/.test(
        file.fileName,
      ) ||
      typeof file.declaredBytes !== "number" ||
      !Number.isSafeInteger(file.declaredBytes) ||
      file.declaredBytes < 1
    )
      throw error(ImportSessionErrorCode.INVALID_INPUT);
    if (file.declaredBytes > IMPORT_SESSION_LIMITS.bytesPerFile)
      throw error(ImportSessionErrorCode.LIMIT_EXCEEDED);
    if (!mime(file.mime))
      throw error(ImportSessionErrorCode.UNSUPPORTED_DOCUMENT);
    ids.add(file.id);
    return Object.freeze({
      id: file.id,
      fileName: file.fileName,
      declaredBytes: file.declaredBytes,
      mime: file.mime,
    });
  });
  return Object.freeze({
    expectedRevision: body.expectedRevision,
    files: Object.freeze(files),
  });
}

@Injectable()
export class ImportUploadService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
    @Inject(IMPORT_SESSION_CAPABILITY)
    private readonly capability: ImportSessionCapability,
    @Inject(IMPORT_SESSION_GRANT_VERIFIER)
    private readonly verifier: UiImportPersistenceGrantVerifier,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
  ) {}

  assertAvailable(operation: "RESERVE" | "UPLOAD"): void {
    assertImportSessionOperationAvailable(
      operation,
      importIntakeEnabled(this.capability),
    );
    this.runtime();
  }
  private runtime(): Runtime {
    const runtime = this.gate.boot.runtime();
    if (!runtime) throw error(ImportSessionErrorCode.CAPABILITY_DISABLED);
    return runtime;
  }
  private current(runtime: Runtime): undefined {
    if (this.gate.boot.stopped.aborted || this.gate.boot.runtime() !== runtime)
      throw error(ImportSessionErrorCode.CAPABILITY_DISABLED);
    return undefined;
  }
  private async authorized(
    tx: Tx,
    auth: AuthenticatedImportContext,
    id: string,
    now: Date,
  ): Promise<ImportSession> {
    const actor = await reauthorize(tx, auth, now);
    const row = await loadOwnedImportSession(tx, actor, id);
    await assertImportSessionAccess(tx, actor, row, now);
    return row;
  }
  private read<T>(
    runtime: Runtime,
    work: (tx: Tx, now: Date) => Promise<T>,
  ): Promise<T> {
    this.current(runtime);
    return this.prisma.$transaction(
      async (tx) => {
        this.current(runtime);
        const value = await work(tx, this.clock.now());
        this.current(runtime);
        return value;
      },
      {
        maxWait: IMPORT_SESSION_LIMITS.transactionMaxWaitMs,
        timeout: IMPORT_SESSION_LIMITS.transactionTimeoutMs,
      },
    );
  }
  private write<T>(
    runtime: Runtime,
    auth: Pick<AuthenticatedImportContext, "tenantId">,
    work: (tx: Tx, now: Date) => Promise<T>,
  ): Promise<T> {
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        this.current(runtime);
        const value = await work(tx, now);
        this.current(runtime);
        return value;
      },
      () => this.current(runtime),
    );
  }
  private async probe(runtime: Runtime): Promise<void> {
    this.current(runtime);
    const checked = await this.gate.boot.recheckLock();
    this.current(runtime);
    if (!checked.ok || checked.runtime !== runtime)
      throw error(ImportSessionErrorCode.CAPABILITY_DISABLED);
  }
  private editable(row: ImportSession, now: Date): void {
    if (effectiveState(row, now) === ImportSessionState.EXPIRED)
      throw error(ImportSessionErrorCode.SESSION_EXPIRED);
    if (!IMPORT_SESSION_UPLOAD_EDITABLE_STATES.includes(row.state))
      throw error(ImportSessionErrorCode.LEASE_CONFLICT);
  }
  private withoutPendingAttachment(
    row: ImportSession,
    attachmentId: string,
  ): string {
    const draft = parseStoredDraft(row.draftJson);
    if (!draft.scope.pendingAttachmentIds.includes(attachmentId))
      return row.draftJson;
    return canonical(
      validateStoredDraft({
        ...draft,
        scope: {
          ...draft.scope,
          pendingAttachmentIds: draft.scope.pendingAttachmentIds.filter(
            (id) => id !== attachmentId,
          ),
        },
      }),
    );
  }
  private async view(
    tx: Tx,
    row: ImportSession,
    auth: AuthenticatedImportContext,
    now: Date,
  ): Promise<ImportSessionViewV1> {
    const actor = await reauthorize(tx, auth, now);
    const canMutate = await canMutateImportSession(
      tx,
      actor,
      row.ownerProjectId,
    );
    return (
      await renderImportSession(tx, row, now, {
        includeReceipt: true,
        qualifiedAnalysisFormats: this.capability.newImportFormats(),
        analysisEnabled:
          importIntakeEnabled(this.capability) &&
          !this.gate.boot.stopped.aborted &&
          this.gate.boot.runtime() !== null,
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

  async reserve(
    auth: AuthenticatedImportContext,
    id: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionViewV1> {
    this.assertAvailable("RESERVE");
    assertMintedImportContext(auth);
    assertSessionId(id);
    const request = parseReserveRequest(body);
    if (
      request.files.some(
        (file) =>
          !(
            (/\.csv$/i.test(file.fileName) &&
              this.capability.newImportFormats().includes("CSV") &&
              MIME_FORMAT[file.mime].includes("CSV")) ||
            (/\.pdf$/i.test(file.fileName) &&
              file.mime === "application/pdf" &&
              this.capability.newImportFormats().includes("PDF"))
          ),
      )
    )
      throw error(ImportSessionErrorCode.UNSUPPORTED_DOCUMENT);
    const runtime = this.runtime();
    await this.read(runtime, (tx, now) => this.authorized(tx, auth, id, now));
    await this.probe(runtime);
    let spent = false;
    return this.write(runtime, auth, async (tx, now) => {
      const row = await this.authorized(tx, auth, id, now);
      const refs = await tx.importSessionArtifact.findMany({
        where: {
          tenantId: auth.tenantId,
          ownerProjectId: row.ownerProjectId,
          sessionId: id,
        },
      });
      const known = refs.filter((ref) =>
        request.files.some((file) => file.id === ref.id),
      );
      if (known.length > 0) {
        if (
          known.length !== request.files.length ||
          !request.files.every((file) =>
            known.some(
              (ref) =>
                ref.id === file.id &&
                ref.fileName === file.fileName &&
                ref.declaredBytes === file.declaredBytes &&
                ref.declaredMime === file.mime,
            ),
          )
        )
          throw error(ImportSessionErrorCode.IDEMPOTENCY_CONFLICT);
        return this.view(tx, row, auth, now);
      }
      this.editable(row, now);
      if (row.revision !== request.expectedRevision)
        throw new ImportSessionError(ImportSessionErrorCode.REVISION_CONFLICT, {
          sessionId: row.id,
          currentRevision: row.revision,
        });
      const bytes = request.files.reduce(
        (sum, file) => sum + file.declaredBytes,
        0,
      );
      if (
        refs.length + request.files.length >
          IMPORT_SESSION_LIMITS.filesPerSession ||
        refs
          .filter((ref) => ref.state !== ImportSessionAttachmentState.RELEASED)
          .reduce((sum, ref) => sum + ref.declaredBytes, 0) +
          bytes >
          IMPORT_SESSION_LIMITS.bytesPerSession
      )
        throw error(ImportSessionErrorCode.LIMIT_EXCEEDED);
      await this.quota(tx, auth, bytes);
      const draft = parseStoredDraft(row.draftJson);
      const updatedDraft = validateStoredDraft({
        ...draft,
        scope: {
          ...draft.scope,
          pendingAttachmentIds: [
            ...new Set([
              ...draft.scope.pendingAttachmentIds,
              ...request.files.map((file) => file.id),
            ]),
          ],
        },
      });
      const draftJson = canonical(updatedDraft);
      if (
        Buffer.byteLength(draftJson, "utf8") >
          IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal ||
        row.revision >= IMPORT_SESSION_PRIMITIVES.maxRevision
      )
        throw error(ImportSessionErrorCode.LIMIT_EXCEEDED);
      this.current(runtime);
      if (!spent) {
        this.verifier.verify(
          grant,
          auth,
          {
            operation: "RESERVE_ATTACHMENTS",
            sessionId: id,
            expectedRevision: request.expectedRevision,
          },
          now,
        );
        spent = true;
      }
      const tokenExpiresAt = new Date(auth.tokenExpiresAt);
      const lease = new Date(
        Math.min(
          tokenExpiresAt.getTime(),
          now.getTime() +
            IMPORT_SESSION_LIMITS.uploadLeaseSeconds *
              IMPORT_SESSION_LIMITS.filesPerRequest *
              1000,
        ),
      );
      let position = 0;
      for (const file of request.files) {
        while (refs.some((ref) => ref.position === position)) position++;
        this.current(runtime);
        try {
          await tx.importSessionArtifact.create({
            data: {
              id: file.id,
              tenantId: auth.tenantId,
              ownerProjectId: row.ownerProjectId,
              sessionId: id,
              position: position++,
              fileName: file.fileName,
              declaredMime: file.mime,
              declaredBytes: file.declaredBytes,
              state: ImportSessionAttachmentState.RESERVED,
              temporaryStorageKey: `t/${file.id}`,
              reservedBytes: file.declaredBytes,
              uploadGeneration: 1,
              uploadSessionVersion: auth.presentedSessionVersion,
              uploadTokenExpiresAt: tokenExpiresAt,
              uploadLeaseExpiresAt: lease,
            },
          });
        } catch (failure) {
          if (
            failure instanceof Prisma.PrismaClientKnownRequestError &&
            failure.code === "P2002"
          )
            throw error(ImportSessionErrorCode.INVALID_INPUT);
          throw failure;
        }
      }
      this.current(runtime);
      const changed = await tx.importSession.updateMany({
        where: {
          id,
          tenantId: auth.tenantId,
          ownerUserId: auth.userId,
          revision: row.revision,
        },
        data: {
          revision: { increment: 1 },
          draftJson,
          searchJson: null,
          proposalJson: null,
          proposalHash: null,
          preflightHash: null,
          challengeJson: null,
          prepareLeaseJson: null,
          prepareGeneration: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw error(ImportSessionErrorCode.REVISION_CONFLICT);
      return this.view(tx, await this.authorized(tx, auth, id, now), auth, now);
    });
  }

  private async quota(
    tx: Tx,
    auth: AuthenticatedImportContext,
    bytes: number,
  ): Promise<void> {
    for (const tenantId of [undefined, auth.tenantId]) {
      const temporary = await tx.importSessionArtifact.aggregate({
        where: { tenantId, temporaryStorageKey: { not: null } },
        _sum: { reservedBytes: true },
      });
      const retained = await tx.importArtifact.aggregate({
        where: { tenantId, storageKey: { not: null } },
        _sum: { verifiedBytes: true },
      });
      const limit =
        tenantId === undefined
          ? IMPORT_SESSION_LIMITS.storedAndReservedBytesGlobal
          : IMPORT_SESSION_LIMITS.storedAndReservedBytesPerTenant;
      if (
        (temporary._sum.reservedBytes ?? 0) +
          (retained._sum.verifiedBytes ?? 0) +
          bytes >
        limit
      )
        throw error(ImportSessionErrorCode.LIMIT_EXCEEDED);
    }
    const temporary = await tx.importSessionArtifact.aggregate({
      where: {
        tenantId: auth.tenantId,
        temporaryStorageKey: { not: null },
        session: { tenantId: auth.tenantId, ownerUserId: auth.userId },
      },
      _sum: { reservedBytes: true },
    });
    let charged = temporary._sum.reservedBytes ?? 0;
    const artifacts = await tx.importArtifact.findMany({
      where: { tenantId: auth.tenantId, storageKey: { not: null } },
      include: {
        references: {
          where: { tenantId: auth.tenantId },
          select: {
            id: true,
            state: true,
            releasedAt: true,
            updatedAt: true,
            session: { select: { ownerUserId: true, tenantId: true } },
          },
        },
      },
    });
    for (const artifact of artifacts) {
      const attached = artifact.references.filter(
        (ref) =>
          ref.state === ImportSessionAttachmentState.ATTACHED &&
          ref.session.tenantId === auth.tenantId,
      );
      if (attached.length > 0) {
        if (attached.some((ref) => ref.session.ownerUserId === auth.userId))
          charged += artifact.verifiedBytes;
      } else {
        const released = artifact.references
          .filter(
            (ref) =>
              ref.state === ImportSessionAttachmentState.RELEASED &&
              ref.session.tenantId === auth.tenantId,
          )
          .sort(
            (a, b) =>
              (b.releasedAt ?? b.updatedAt).getTime() -
                (a.releasedAt ?? a.updatedAt).getTime() ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
        if (released[0]?.session.ownerUserId === auth.userId)
          charged += artifact.verifiedBytes;
      }
    }
    if (
      charged + bytes >
      IMPORT_SESSION_LIMITS.activeSessionsPerUser *
        IMPORT_SESSION_LIMITS.bytesPerSession
    )
      throw error(ImportSessionErrorCode.LIMIT_EXCEEDED);
  }

  private async ref(
    tx: Tx,
    row: ImportSession,
    attachmentId: string,
    missingCode:
      | typeof ImportSessionErrorCode.NOT_FOUND
      | typeof ImportSessionErrorCode.LEASE_CONFLICT = ImportSessionErrorCode.NOT_FOUND,
  ): Promise<ImportSessionArtifact> {
    const ref = await tx.importSessionArtifact.findFirst({
      where: {
        id: attachmentId,
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        sessionId: row.id,
      },
    });
    if (!ref) throw error(missingCode);
    return ref;
  }
  private validClaim(
    ref: ImportSessionArtifact,
    claim: VaultUploadClaim,
    now: Date,
  ): void {
    if (
      ref.state !== ImportSessionAttachmentState.RESERVED ||
      ref.uploadGeneration !== claim.uploadGeneration ||
      ref.temporaryPurgePending ||
      ref.temporaryStorageKey !== claim.temporaryStorageKey ||
      !ref.uploadLeaseExpiresAt ||
      ref.uploadLeaseExpiresAt.getTime() <= now.getTime()
    )
      throw error(ImportSessionErrorCode.LEASE_CONFLICT);
    if (
      ref.uploadSessionVersion !== claim.uploadSessionVersion ||
      !ref.uploadTokenExpiresAt ||
      ref.uploadTokenExpiresAt.getTime() <= now.getTime()
    )
      throw error(ImportSessionErrorCode.UNAUTHENTICATED);
  }
  async upload(
    auth: AuthenticatedImportContext,
    id: string,
    attachmentId: string,
    length: number,
    source: Readable & { aborted?: boolean },
    grant: unknown,
  ): Promise<ImportSessionViewV1> {
    const result = await this.uploadWithOutcome(
      auth,
      id,
      attachmentId,
      length,
      source,
      grant,
    );
    return "kind" in result ? result.view : result;
  }

  async uploadWithOutcome(
    auth: AuthenticatedImportContext,
    id: string,
    attachmentId: string,
    length: number,
    source: Readable & { aborted?: boolean },
    grant: unknown,
  ): Promise<ImportSessionUploadResponseV1> {
    this.assertAvailable("UPLOAD");
    assertMintedImportContext(auth);
    assertSessionId(id);
    assertSessionId(attachmentId);
    const runtime = this.runtime();
    const check = (): undefined => {
      this.current(runtime);
      if (source.aborted) throw error(ImportSessionErrorCode.INVALID_INPUT);
      return undefined;
    };
    await this.read(runtime, async (tx, now) => {
      const row = await this.authorized(tx, auth, id, now);
      await this.ref(tx, row, attachmentId);
    });
    await this.probe(runtime);
    check();
    let spent = false;
    const result = await this.write<
      | { view: ImportSessionViewV1; deduplicated: boolean }
      | { claim: VaultUploadClaim }
    >(runtime, auth, async (tx, now) => {
      const claimedAtMonotonicMs = performance.now();
      check();
      const row = await this.authorized(tx, auth, id, now);
      const ref = await this.ref(tx, row, attachmentId);
      this.editable(row, now);
      if (ref.state === ImportSessionAttachmentState.ATTACHED)
        return {
          view: await this.view(tx, row, auth, now),
          deduplicated: false,
        };
      if (
        ref.state === ImportSessionAttachmentState.RELEASED &&
        ref.verifiedAt &&
        ref.releasedAt &&
        !ref.artifactId
      ) {
        const draftJson = this.withoutPendingAttachment(row, ref.id);
        if (draftJson === row.draftJson)
          return {
            view: await this.view(tx, row, auth, now),
            deduplicated: true,
          };
        const repaired = await tx.importSession.updateMany({
          where: {
            id: row.id,
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            ownerUserId: row.ownerUserId,
            revision: row.revision,
            state: row.state,
          },
          data: { draftJson, revision: { increment: 1 } },
        });
        if (repaired.count !== 1)
          throw error(ImportSessionErrorCode.REVISION_CONFLICT);
        return {
          view: await this.view(
            tx,
            await this.authorized(tx, auth, row.id, now),
            auth,
            now,
          ),
          deduplicated: true,
        };
      }
      if (
        ref.state !== ImportSessionAttachmentState.RESERVED ||
        ref.uploadGeneration !== 1 ||
        ref.temporaryPurgePending ||
        !ref.uploadLeaseExpiresAt ||
        ref.uploadLeaseExpiresAt.getTime() <= now.getTime()
      )
        throw error(ImportSessionErrorCode.LEASE_CONFLICT);
      if (
        !ref.uploadTokenExpiresAt ||
        ref.uploadTokenExpiresAt.getTime() <= now.getTime() ||
        ref.uploadSessionVersion !== auth.presentedSessionVersion
      )
        throw error(ImportSessionErrorCode.UNAUTHENTICATED);
      if (length !== ref.declaredBytes)
        throw error(ImportSessionErrorCode.INVALID_INPUT);
      if (!mime(ref.declaredMime))
        throw error(ImportSessionErrorCode.UNSUPPORTED_DOCUMENT);
      const active = await tx.importSessionArtifact.findMany({
        where: {
          tenantId: auth.tenantId,
          state: ImportSessionAttachmentState.RESERVED,
          uploadGeneration: 2,
        },
        select: { id: true, session: { select: { ownerUserId: true } } },
      });
      const tenantSlots = new Set(active.map((ref) => ref.id));
      const userSlots = new Set(
        active
          .filter((ref) => ref.session.ownerUserId === auth.userId)
          .map((ref) => ref.id),
      );
      for (const live of this.gate.registry.snapshotUploads()) {
        if (live.tenantId !== auth.tenantId) continue;
        tenantSlots.add(live.refId);
        if (live.ownerUserId === auth.userId) userSlots.add(live.refId);
      }
      if (
        tenantSlots.size >= IMPORT_SESSION_LIMITS.concurrentUploadsPerTenant ||
        userSlots.size >= 1
      )
        throw error(ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT);
      await this.view(tx, row, auth, now);
      check();
      if (!spent) {
        this.verifier.verify(
          grant,
          auth,
          {
            operation: "UPLOAD_CONTENT",
            sessionId: id,
            attachmentId,
            uploadGeneration: 1,
          },
          now,
        );
        spent = true;
      }
      const lease = Math.min(
        ref.uploadTokenExpiresAt.getTime(),
        Date.parse(auth.tokenExpiresAt),
        row.expiresAt.getTime(),
        now.getTime() + IMPORT_SESSION_LIMITS.uploadLeaseSeconds * 1000,
      );
      const changed = await tx.importSessionArtifact.updateMany({
        where: {
          id: ref.id,
          tenantId: auth.tenantId,
          ownerProjectId: row.ownerProjectId,
          sessionId: id,
          state: ImportSessionAttachmentState.RESERVED,
          uploadGeneration: 1,
          temporaryPurgePending: false,
          uploadLeaseExpiresAt: { gt: now },
        },
        data: { uploadGeneration: 2, uploadLeaseExpiresAt: new Date(lease) },
      });
      if (changed.count !== 1)
        throw error(ImportSessionErrorCode.LEASE_CONFLICT);
      const claim: VaultUploadClaim = Object.freeze({
        tenantId: auth.tenantId,
        ownerProjectId: row.ownerProjectId,
        ownerUserId: auth.userId,
        sessionId: id,
        refId: ref.id,
        uploadGeneration: 2,
        temporaryStorageKey: `t/${ref.id}`,
        declaredBytes: ref.declaredBytes,
        declaredMime: ref.declaredMime,
        uploadSessionVersion: auth.presentedSessionVersion,
        tokenExpiresAtMs: Date.parse(auth.tokenExpiresAt),
        uploadTokenExpiresAtMs: ref.uploadTokenExpiresAt.getTime(),
        uploadLeaseExpiresAtMs: lease,
        sessionExpiresAtMs: row.expiresAt.getTime(),
        claimedAtMs: now.getTime(),
        claimedAtMonotonicMs,
      });
      return { claim };
    });
    if ("view" in result)
      return result.deduplicated
        ? { kind: "DEDUPLICATED", attachmentId, view: result.view }
        : result.view;
    const claim = result.claim;
    try {
      check();
      const stored = await this.gate.storage.writeClaim(
        claim,
        source,
        (captured) =>
          this.read(runtime, async (tx, now) => {
            const row = await this.authorized(
              tx,
              auth,
              captured.sessionId,
              now,
            );
            this.editable(row, now);
            this.validClaim(
              await this.ref(
                tx,
                row,
                captured.refId,
                ImportSessionErrorCode.LEASE_CONFLICT,
              ),
              captured,
              now,
            );
            check();
          }),
      );
      check();
      const finalized = await this.finalize(
        runtime,
        auth,
        claim,
        stored,
        check,
      );
      return finalized.deduplicated
        ? { kind: "DEDUPLICATED", attachmentId, view: finalized.view }
        : finalized.view;
    } catch (failure) {
      // Cleanup authority is the captured claim, never a newly supplied user context.
      if (
        this.gate.boot.runtime() === runtime &&
        !this.gate.boot.stopped.aborted
      ) {
        try {
          await this.write(runtime, claim, async (tx) => {
            await tx.importSessionArtifact.updateMany({
              where: {
                id: claim.refId,
                tenantId: claim.tenantId,
                ownerProjectId: claim.ownerProjectId,
                sessionId: claim.sessionId,
                state: ImportSessionAttachmentState.RESERVED,
                uploadGeneration: 2,
              },
              data: {
                state: ImportSessionAttachmentState.FAILED,
                uploadGeneration: { increment: 1 },
                temporaryPurgePending: true,
                uploadLeaseExpiresAt: null,
                uploadSessionVersion: null,
                uploadTokenExpiresAt: null,
              },
            });
          });
        } catch (cleanup) {
          new Logger("ImportUpload").error({
            event: "vault_self_fence_failed",
            kind:
              cleanup instanceof ImportSessionError ? cleanup.code : "UNKNOWN",
          });
        }
      }
      if (failure instanceof VaultIoError) {
        new Logger("ImportUpload").error({
          event: "vault_upload_failed",
          kind: failure.kind,
          step: failure.step,
          code: failure.code,
        });
        if (failure.kind === "UNAVAILABLE")
          throw error(ImportSessionErrorCode.CAPABILITY_DISABLED);
        if (failure.kind === "UNSUPPORTED_DOCUMENT")
          throw error(ImportSessionErrorCode.UNSUPPORTED_DOCUMENT);
        if (failure.kind === "SIZE_MISMATCH" || failure.kind === "STREAM_ERROR")
          throw error(ImportSessionErrorCode.INVALID_INPUT);
        if (
          failure.kind === "DEADLINE_EXCEEDED" ||
          failure.kind === "IDLE_TIMEOUT" ||
          failure.kind === "FENCED"
        )
          throw error(ImportSessionErrorCode.LEASE_CONFLICT);
        throw error(ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT);
      }
      throw failure;
    }
  }

  private async finalize(
    runtime: Runtime,
    auth: AuthenticatedImportContext,
    claim: VaultUploadClaim,
    stored: StoredVaultUpload,
    check: () => undefined,
  ): Promise<{ view: ImportSessionViewV1; deduplicated: boolean }> {
    for (
      let attempt = 0;
      attempt < IMPORT_SESSION_LIMITS.writeAttempts;
      attempt++
    ) {
      const result = await this.write<
        | { needsPurge: string }
        | { view: ImportSessionViewV1; deduplicated: boolean }
      >(runtime, auth, async (tx, now) => {
        check();
        const row = await this.authorized(tx, auth, claim.sessionId, now);
        this.editable(row, now);
        const ref = await this.ref(
          tx,
          row,
          claim.refId,
          ImportSessionErrorCode.LEASE_CONFLICT,
        );
        this.validClaim(ref, claim, now);
        check();
        let artifact = await tx.importArtifact.findFirst({
          where: {
            tenantId: claim.tenantId,
            ownerProjectId: claim.ownerProjectId,
            documentSha256: stored.documentSha256,
          },
        });
        // No ref/lease/storage mutation may commit before this occupant finishes
        // erasure. The purger owns its own writer transactions and FD fencing.
        if (artifact?.state === ImportSessionArtifactState.PURGING)
          return { needsPurge: artifact.id } as const;
        const changed = await tx.importSessionArtifact.updateMany({
          where: {
            id: claim.refId,
            tenantId: claim.tenantId,
            ownerProjectId: claim.ownerProjectId,
            sessionId: claim.sessionId,
            state: ImportSessionAttachmentState.RESERVED,
            uploadGeneration: 2,
            temporaryPurgePending: false,
            uploadLeaseExpiresAt: { gt: now },
          },
          data: {
            verifiedAt: now,
            uploadLeaseExpiresAt: null,
            uploadTokenExpiresAt: null,
            uploadSessionVersion: null,
          },
        });
        if (changed.count !== 1)
          throw error(ImportSessionErrorCode.LEASE_CONFLICT);
        const adoption =
          artifact === null ||
          artifact.state === ImportSessionArtifactState.PURGED;
        check();
        if (artifact === null) {
          artifact = await tx.importArtifact.create({
            data: {
              tenantId: claim.tenantId,
              ownerProjectId: claim.ownerProjectId,
              documentSha256: stored.documentSha256,
              verifiedBytes: stored.verifiedBytes,
              detectedFormat: stored.detectedFormat,
              storageKey: stored.storageKey,
              state: ImportSessionArtifactState.RAW_READY,
            },
          });
        } else if (artifact.state === ImportSessionArtifactState.PURGED) {
          const adopted = await tx.importArtifact.updateMany({
            where: {
              id: artifact.id,
              tenantId: claim.tenantId,
              ownerProjectId: claim.ownerProjectId,
              documentSha256: stored.documentSha256,
              state: ImportSessionArtifactState.PURGED,
              storageKey: null,
            },
            data: {
              state: ImportSessionArtifactState.RAW_READY,
              storageKey: stored.storageKey,
              verifiedBytes: stored.verifiedBytes,
              detectedFormat: stored.detectedFormat,
              parserVersion: null,
              extractionJson: null,
            },
          });
          if (adopted.count !== 1)
            throw error(ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT);
        }
        const duplicate = await tx.importSessionArtifact.findFirst({
          where: {
            tenantId: claim.tenantId,
            ownerProjectId: claim.ownerProjectId,
            sessionId: claim.sessionId,
            artifactId: artifact.id,
            id: { not: claim.refId },
          },
        });
        check();
        const finalized = await tx.importSessionArtifact.updateMany({
          where: {
            id: claim.refId,
            tenantId: claim.tenantId,
            ownerProjectId: claim.ownerProjectId,
            sessionId: claim.sessionId,
            uploadGeneration: 2,
          },
          data: {
            state: duplicate
              ? ImportSessionAttachmentState.RELEASED
              : ImportSessionAttachmentState.ATTACHED,
            artifactId: duplicate ? null : artifact.id,
            releasedAt: duplicate ? now : null,
            temporaryStorageKey: adoption ? null : claim.temporaryStorageKey,
            reservedBytes: adoption ? 0 : ref.reservedBytes,
            temporaryPurgePending: !adoption,
          },
        });
        if (finalized.count !== 1)
          throw error(ImportSessionErrorCode.LEASE_CONFLICT);
        check();
        const updatedSession = await tx.importSession.updateMany({
          where: {
            id: claim.sessionId,
            tenantId: claim.tenantId,
            ownerProjectId: claim.ownerProjectId,
            ownerUserId: auth.userId,
            revision: row.revision,
          },
          data: {
            revision: { increment: 1 },
            ...(duplicate
              ? { draftJson: this.withoutPendingAttachment(row, claim.refId) }
              : {}),
          },
        });
        if (updatedSession.count !== 1)
          throw error(ImportSessionErrorCode.REVISION_CONFLICT);
        return {
          view: await this.view(
            tx,
            await this.authorized(tx, auth, claim.sessionId, now),
            auth,
            now,
          ),
          deduplicated: duplicate !== null,
        } as const;
      });
      if ("view" in result) return result;
      check();
      const purged = await this.gate.requirePurger().purge({
        kind: "artifact",
        tenantId: claim.tenantId,
        ownerProjectId: claim.ownerProjectId,
        id: result.needsPurge,
      });
      check();
      if (purged === "DRAIN_TIMEOUT")
        throw error(ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT);
      // Reauthorize and validate the upload lease/ref in a fresh writer even on
      // STALE_CAPTURE/NOT_ELIGIBLE: a deletion or another uploader may have won.
    }
    throw error(ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT);
  }
}
