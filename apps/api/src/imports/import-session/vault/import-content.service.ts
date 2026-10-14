import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { Readable } from "node:stream";
import {
  IMPORT_SESSION_LIMITS,
  ImportSessionErrorCode,
  ImportSessionState,
  ImportSessionArtifactState,
  ImportSessionAttachmentState,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { assertMintedImportContext, reauthorize } from "../import-session.auth";
import {
  IMPORT_SESSION_CLOCK,
  type ImportSessionClock,
} from "../import-session.capability";
import type { AuthenticatedImportContext } from "../import-session.contract";
import { ImportSessionError } from "../import-session.errors";
import {
  assertSessionId,
  loadOwnedImportSession,
  assertImportSessionAccess,
} from "../import-session.service";
import { effectiveState } from "../import-session.projection";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault-state";
import { VaultIoError, type VaultArtifactRead } from "./vault-storage";

type Runtime = NonNullable<ReturnType<ImportVaultGate["boot"]["runtime"]>>;
const READABLE_ARTIFACTS: readonly string[] = [
  ImportSessionArtifactState.RAW_READY,
  ImportSessionArtifactState.ANALYZING,
  ImportSessionArtifactState.EXTRACTED,
  ImportSessionArtifactState.FAILED,
];
const notFound = () => new ImportSessionError(ImportSessionErrorCode.NOT_FOUND);

@Injectable()
export class ImportContentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
  ) {}
  private current(runtime: Runtime): void {
    if (this.gate.boot.stopped.aborted || this.gate.boot.runtime() !== runtime)
      throw new ImportSessionError(ImportSessionErrorCode.CAPABILITY_DISABLED);
  }
  private read<T>(
    runtime: Runtime,
    work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
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
  private async authorized(
    tx: Prisma.TransactionClient,
    auth: AuthenticatedImportContext,
    id: string,
    attachmentId: string,
    now: Date,
  ) {
    const actor = await reauthorize(tx, auth, now);
    const row = await loadOwnedImportSession(tx, actor, id, now);
    await assertImportSessionAccess(tx, actor, row, now);
    const state = effectiveState(row, now);
    if (
      state === ImportSessionState.CANCELLED ||
      state === ImportSessionState.EXPIRED
    )
      throw notFound();
    const ref = await tx.importSessionArtifact.findFirst({
      where: {
        id: attachmentId,
        tenantId: auth.tenantId,
        ownerProjectId: row.ownerProjectId,
        sessionId: id,
        state: ImportSessionAttachmentState.ATTACHED,
      },
    });
    if (!ref?.artifactId) throw notFound();
    const artifact = await tx.importArtifact.findFirst({
      where: {
        id: ref.artifactId,
        tenantId: auth.tenantId,
        ownerProjectId: row.ownerProjectId,
        OR: [
          { state: { in: [...READABLE_ARTIFACTS] } },
          // Documentary consent survives identity retirement, never purge or
          // rematerialization authority. The owned ATTACHED ref above is required
          // again at reader admission; cancellation/expiry deny this path.
          { state: ImportSessionArtifactState.PURGING, documentSha256: null },
        ],
        storageKey: { not: null },
      },
    });
    if (!artifact?.storageKey) throw notFound();
    const capture: VaultArtifactRead = Object.freeze({
      tenantId: auth.tenantId,
      ownerProjectId: row.ownerProjectId,
      ownerUserId: auth.userId,
      sessionId: id,
      refId: ref.id,
      artifactId: artifact.id,
      storageKey: artifact.storageKey,
    });
    return {
      capture,
      fileName: ref.fileName,
      verifiedBytes: artifact.verifiedBytes,
    };
  }

  async download<T>(
    auth: AuthenticatedImportContext,
    id: string,
    attachmentId: string,
    consume: (
      source: Readable,
      metadata: Readonly<{ fileName: string; verifiedBytes: number }>,
    ) => Promise<T>,
  ): Promise<T> {
    const runtime = this.gate.boot.runtime();
    if (!runtime)
      throw new ImportSessionError(ImportSessionErrorCode.CAPABILITY_DISABLED);
    assertMintedImportContext(auth);
    assertSessionId(id);
    assertSessionId(attachmentId);
    const captured = await this.read(runtime, (tx, now) =>
      this.authorized(tx, auth, id, attachmentId, now),
    );
    this.current(runtime);
    const proof = await this.gate.boot.recheckLock();
    this.current(runtime);
    if (!proof.ok || proof.runtime !== runtime)
      throw new ImportSessionError(ImportSessionErrorCode.CAPABILITY_DISABLED);
    try {
      return await this.gate.storage.withArtifactReader(
        captured.capture,
        (capture) =>
          this.read(runtime, async (tx, now) => {
            const fresh = await this.authorized(
              tx,
              auth,
              id,
              attachmentId,
              now,
            );
            if (
              fresh.capture.artifactId !== capture.artifactId ||
              fresh.capture.storageKey !== capture.storageKey ||
              fresh.capture.ownerProjectId !== capture.ownerProjectId ||
              fresh.verifiedBytes !== captured.verifiedBytes
            )
              throw notFound();
          }),
        (source) => consume(source, captured),
      );
    } catch (failure) {
      if (failure instanceof VaultIoError) {
        new Logger("ImportContent").error({
          event: "vault_read_failed",
          kind: failure.kind,
          step: failure.step,
          code: failure.code,
        });
        if (failure.kind === "UNAVAILABLE")
          throw new ImportSessionError(
            ImportSessionErrorCode.CAPABILITY_DISABLED,
          );
        throw notFound();
      }
      throw failure;
    }
  }
}
