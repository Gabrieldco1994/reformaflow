import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_LIMITS,
  ProjectType,
  ExpenseType,
  PaymentForm,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { ImportSessionService } from "../import-session.service";
import { ImportSessionWorkflowService } from "../import-session-workflow.service";
import {
  DefaultImportSessionCapability,
  importSessionWritesEnabled,
} from "../import-session.capability";
import { mintImportAuthContext } from "../import-session.auth";
import { EMPTY_DRAFT_JSON } from "../import-session.projection";
import { VaultReaper } from "./vault-reaper";
import { ImportUploadService } from "./import-upload.service";
import { ImportContentService } from "./import-content.service";
import { ImportSessionExtractionService } from "../import-session.extraction.service";
import { ImportRawExecutions } from "../import-session.raw-executions";
import { CardPurchaseBatchAdapter } from "../card-purchase-batch.adapter";
import { ConciliacaoService } from "../../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../../expense/expense.service";
import { ReceiptService } from "../../../receipt/receipt.service";
import { buildImportMaterialization } from "../import-session.extraction";
import { extractCardStatementDocument } from "../../../credit-card/parsers/statement-document";
import { RuntimeUiGrantVerifier } from "../import-session-ui-grant";
import { VaultStorage, VaultIoError } from "./vault-storage";
import { VaultFdRegistry } from "./vault-fd-registry";
import { PurgeCoordinator } from "./vault-purger";
import type { VaultBootHandle, VaultRuntime } from "./vault-boot";

// Jest's mandatory setupFiles has already refused dev.db and selected the worker DB.
describe("guarded persisted session retention", () => {
  const prisma = new PrismaService();
  let current = new Date("2026-10-09T20:00:00.000Z");
  const clock = { now: () => current };
  const capability = new DefaultImportSessionCapability();
  const runtime = {};
  const gate = {
    boot: {
      runtime: () => runtime,
      stopped: { aborted: false },
      recheckLock: async () => ({ ok: true, runtime }),
    },
  };
  const verifier = {
    verify: jest.fn().mockReturnValue({}),
    verifyFinancialAction: jest.fn(),
  };
  const raw = { abortOwned: jest.fn() };
  const service = new ImportSessionService(
    prisma,
    clock,
    capability,
    verifier as never,
    gate as never,
    raw as never,
  );
  let tenantId: string;
  let userId: string;
  let projectId: string;
  let cardId: string;
  let auth: ReturnType<typeof mintImportAuthContext>;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    expect(process.env.DATABASE_URL).not.toContain("dev.db");
    await prisma.$connect();
  });
  beforeEach(async () => {
    current = new Date("2026-10-09T20:00:00.000Z");
    const tenant = await prisma.tenant.create({
      data: { name: "retention fixture" },
    });
    tenantId = tenant.id;
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: randomUUID(),
        name: "retention fixture",
        role: "ADMIN",
      },
    });
    userId = user.id;
    const project = await prisma.project.create({
      data: { tenantId, name: "retention fixture", type: ProjectType.PESSOAL },
    });
    projectId = project.id;
    const card = await prisma.creditCard.create({
      data: {
        tenantId,
        projectId,
        nickname: "fixture",
        institution: "fixture",
        last4: "1234",
        closingDay: 5,
        dueDay: 10,
      },
    });
    cardId = card.id;
    auth = mintImportAuthContext({
      tenantId,
      userId,
      presentedSessionVersion: 0,
      tokenExpiresAt: new Date(current.getTime() + 30 * 86400000).toISOString(),
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const create = () =>
    service.create(
      auth,
      {
        version: 1,
        createRequestId: randomUUID(),
        cardId,
        consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
        consentAnalyze: true,
      },
      {},
    );

  async function withVault(
    work: (vault: {
      root: string;
      registry: VaultFdRegistry;
      purger: PurgeCoordinator;
      upload: ImportUploadService;
      content: ImportContentService;
      extraction: ImportSessionExtractionService;
      reaper: VaultReaper;
    }) => Promise<void>,
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "maria-identity-"));
    const registry = new VaultFdRegistry();
    const runtime: VaultRuntime = {
      config: {
        configured: true,
        rootDir: root,
        lockFd: 3,
        idleTimeoutMs: 1000,
        headroomBytes: 1,
        drainTimeoutMs: 1000,
      },
      lockIdentity: { dev: 1n, ino: 1n },
    };
    const boot = {
      runtime: () => runtime,
      stopped: new AbortController().signal,
      recheckLock: async () => ({ ok: true, runtime }),
    } as VaultBootHandle;
    const storage = new VaultStorage(boot, registry, clock);
    const purger = new PurgeCoordinator(
      prisma,
      clock,
      boot,
      registry,
      storage,
      1000,
    );
    const gate = { boot, storage, registry, requirePurger: () => purger };
    mkdirSync(join(root, "t"), { mode: 0o700 });
    mkdirSync(join(root, "trash"), { mode: 0o700 });
    try {
      await work({
        root,
        registry,
        purger,
        upload: new ImportUploadService(
          prisma,
          clock,
          capability,
          verifier as never,
          gate as never,
        ),
        content: new ImportContentService(prisma, clock, gate as never),
        extraction: new ImportSessionExtractionService(
          prisma,
          clock,
          capability,
          verifier as never,
          gate as never,
          new ImportRawExecutions(gate as never, clock, capability),
        ),
        reaper: new VaultReaper(prisma, clock, gate as never, raw as never),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function reserveBytes(
    upload: ImportUploadService,
    bytes: Buffer,
    actor = auth,
  ) {
    const created = await service.create(
      actor,
      {
        version: 1,
        createRequestId: randomUUID(),
        cardId,
        consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
        consentAnalyze: true,
      },
      {},
    );
    const attachmentId = randomUUID();
    const reserved = await upload.reserve(
      actor,
      created.view.id,
      {
        expectedRevision: created.view.revision,
        files: [
          {
            id: attachmentId,
            fileName: "identity.csv",
            declaredBytes: bytes.length,
            mime: "text/csv",
          },
        ],
      },
      {},
    );
    return { reserved, attachmentId };
  }

  async function uploadBytes(upload: ImportUploadService, bytes: Buffer) {
    const { reserved, attachmentId } = await reserveBytes(upload, bytes);
    const view = await upload.upload(
      auth,
      reserved.id,
      attachmentId,
      bytes.length,
      Readable.from([bytes]),
      {},
    );
    return { view, attachmentId, reserved };
  }

  async function pendingClaimedPurge(root: string) {
    const created = await create();
    const bytes = Buffer.from(
      "date,title,amount\n2026-10-01,Barrier identity fixture,206.96\n",
    );
    const { artifact, ref, material } = await attachCsv(created.view.id, bytes);
    const expense = await new ExpenseService(
      prisma,
      new ConciliacaoService(prisma),
    ).create(tenantId, projectId, {
      tipoDespesa: ExpenseType.OUTROS,
      valor: 206.96,
      quantidade: 1,
      formaPagamento: PaymentForm.A_VISTA,
      status: "PLANEJADO",
    });
    await prisma.importObservation.update({
      where: { id: material.observations[0].id },
      data: {
        canonicalProjectId: projectId,
        canonicalExpenseId: expense.id,
        canonicalIndex: 0,
        claimReceiptJson: "{}",
        claimedAt: current,
      },
    });
    const storageKey = `t/${ref.id}/g2/blob`;
    mkdirSync(join(root, "t", ref.id, "g2"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, storageKey), bytes, { mode: 0o600 });
    await prisma.importArtifact.update({
      where: { id: artifact.id },
      data: { storageKey },
    });
    await service.cancel(
      auth,
      created.view.id,
      { expectedRevision: created.view.revision },
      {},
    );
    await prisma.importArtifact.update({
      where: { id: artifact.id },
      data: { state: "PURGING" },
    });
    return { bytes, artifact, expense };
  }

  it("never-claimed real upload/analyze still hash-shares active intake", async () =>
    withVault(async ({ upload, extraction }) => {
      const bytes = Buffer.from(
        "date,title,amount\n2026-10-01,Intake fixture,206.96\n",
      );
      const first = await uploadBytes(upload, bytes);
      await extraction.analyzeAttached(
        auth,
        first.view.id,
        first.attachmentId,
        { expectedRevision: first.view.revision },
        {},
      );
      const second = await uploadBytes(upload, bytes);
      const firstRef = await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: first.attachmentId },
      });
      const secondRef = await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: second.attachmentId },
      });
      expect(secondRef.artifactId).toBe(firstRef.artifactId);
      await extraction.analyzeAttached(
        auth,
        second.view.id,
        second.attachmentId,
        { expectedRevision: second.view.revision },
        {},
      );
      expect(
        await prisma.importObservation.count({
          where: { artifactId: firstRef.artifactId! },
        }),
      ).toBe(1);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    }));

  it("same-session identical uploads release only the duplicate reservation before preparation", async () =>
    withVault(async ({ upload, extraction }) => {
      const bytes = Buffer.from(
        "date,title,amount\n2026-10-01,Same-session fixture PARC 1/2,1.00\n",
      );
      const created = await create();
      const firstId = randomUUID();
      await upload.reserve(
        auth,
        created.view.id,
        {
          expectedRevision: created.view.revision,
          files: [
            {
              id: firstId,
              fileName: "first.csv",
              declaredBytes: bytes.length,
              mime: "text/csv",
            },
          ],
        },
        {},
      );
      const firstUploaded = await upload.upload(
        auth,
        created.view.id,
        firstId,
        bytes.length,
        Readable.from([bytes]),
        {},
      );
      const analyzed = await extraction.analyzeAttached(
        auth,
        created.view.id,
        firstId,
        { expectedRevision: firstUploaded.revision },
        {},
      );

      const secondId = randomUUID();
      await upload.reserve(
        auth,
        created.view.id,
        {
          expectedRevision: analyzed.revision,
          files: [
            {
              id: secondId,
              fileName: "second.csv",
              declaredBytes: bytes.length,
              mime: "text/csv",
            },
          ],
        },
        {},
      );
      const duplicateResponse = await upload.uploadWithOutcome(
        auth,
        created.view.id,
        secondId,
        bytes.length,
        Readable.from([bytes]),
        {},
      );
      const beforeRetry = await prisma.importSession.findUniqueOrThrow({
        where: { id: created.view.id },
      });
      const staleDraft = JSON.parse(beforeRetry.draftJson);
      staleDraft.scope.pendingAttachmentIds.push(secondId);
      await prisma.importSession.update({
        where: { id: beforeRetry.id },
        data: { draftJson: JSON.stringify(staleDraft) },
      });
      // Model the stale pending id left by the pre-fix finalize implementation.
      const duplicateRetry = await upload.uploadWithOutcome(
        auth,
        created.view.id,
        secondId,
        bytes.length,
        Readable.from([bytes]),
        {},
      );
      const firstRef = await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: firstId },
      });
      const duplicateRef = await prisma.importSessionArtifact.findUniqueOrThrow(
        {
          where: { id: secondId },
        },
      );
      expect(duplicateRef).toMatchObject({
        state: "RELEASED",
        verifiedAt: expect.any(Date),
        artifactId: null,
      });
      expect(duplicateResponse).toMatchObject({
        kind: "DEDUPLICATED",
        attachmentId: secondId,
      });
      expect(duplicateRetry).toMatchObject({
        kind: "DEDUPLICATED",
        attachmentId: secondId,
      });
      if (!("kind" in duplicateResponse) || !("kind" in duplicateRetry))
        throw new Error("duplicate upload must return its explicit outcome");
      expect(duplicateResponse.view.attachments).not.toContainEqual(
        expect.objectContaining({ id: secondId }),
      );
      expect(duplicateRetry.view.revision).toBe(
        duplicateResponse.view.revision + 1,
      );
      expect(
        await prisma.importObservation.count({
          where: { artifactId: firstRef.artifactId! },
        }),
      ).toBe(1);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);

      const session = await prisma.importSession.findUniqueOrThrow({
        where: { id: created.view.id },
      });
      const draft = JSON.parse(session.draftJson);
      expect(draft.scope.pendingAttachmentIds).toEqual([]);

      const preparedDraft = {
        ...draft,
        questions: [],
        selectedLineIds: draft.lines.map((line: { id: string }) => line.id),
        lines: draft.lines.map((line: Record<string, unknown>) => ({
          ...line,
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 200,
          installmentCount: 2,
          firstDueDate: "2026-10-10",
          targets: [],
          tipoDespesa: ExpenseType.OUTROS,
          decision: { kind: "CREATE", acceptNaturalDuplicate: false },
        })),
      };
      await prisma.importSession.update({
        where: { id: session.id },
        data: { draftJson: JSON.stringify(preparedDraft) },
      });
      const conciliacao = new ConciliacaoService(prisma);
      const expenses = new ExpenseService(prisma, conciliacao);
      const workflow = new ImportSessionWorkflowService(
        prisma,
        clock,
        {
          writesEnabled: () => true,
          newImportFormats: capability.newImportFormats.bind(capability),
        },
        verifier,
        new CardPurchaseBatchAdapter(expenses, conciliacao, clock),
        gate as never,
        raw as never,
      );
      const ready = await workflow.prepare(auth, session.id, {
        expectedRevision: duplicateRetry.view.revision,
      });
      expect(ready.state).toBe("READY");
      expect(
        await prisma.importObservation.count({ where: { tenantId } }),
      ).toBe(1);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    }));

  // Port of QA f2d4c90's claimed-PURGING test, using the shared physical fixture.
  // The failed attempt exercises the real coordinator's FD drain outcome.
  it("claimed PURGING finalize retries after fenced drain without duplicating finance or replacing claim identity", async () =>
    withVault(async ({ root, upload, purger, registry }) => {
      const { bytes, artifact } = await pendingClaimedPurge(root);
      const before = await prisma.importArtifact.findUniqueOrThrow({
        where: { id: artifact.id },
      });
      const claims = await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
      });
      const finances = await prisma.expense.findMany({ where: { tenantId } });
      const flows = await prisma.cashFlowEntry.findMany({
        where: { tenantId },
      });
      let transactionDepth = 0;
      const transaction = prisma.$transaction.bind(prisma);
      const txSpy = jest
        .spyOn(prisma, "$transaction")
        .mockImplementation(
          async (...args: Parameters<typeof prisma.$transaction>) => {
            transactionDepth++;
            try {
              return await transaction(...args);
            } finally {
              transactionDepth--;
            }
          },
        );
      const actual = purger.purge.bind(purger);
      const purge = jest.spyOn(purger, "purge").mockImplementation((target) => {
        expect(transactionDepth).toBe(0);
        return actual(target);
      });
      const drain = jest
        .spyOn(registry, "abortAndDrain")
        .mockResolvedValue("TIMEOUT");
      try {
        const pending = await reserveBytes(upload, bytes);
        await expect(
          upload.upload(
            auth,
            pending.reserved.id,
            pending.attachmentId,
            bytes.length,
            Readable.from([bytes]),
            {},
          ),
        ).rejects.toMatchObject({
          code: "RETRYABLE_WRITE_CONFLICT",
        });
        const failed = await prisma.importSessionArtifact.findUniqueOrThrow({
          where: { id: pending.attachmentId },
        });
        expect(failed).toMatchObject({
          state: "FAILED",
          artifactId: null,
          temporaryPurgePending: true,
        });
        expect(purge).toHaveBeenCalledWith({
          kind: "artifact",
          tenantId,
          ownerProjectId: projectId,
          id: artifact.id,
        });
        expect(drain).toHaveBeenCalledWith(`A:${artifact.id}`, 1000);
        expect(existsSync(join(root, before.storageKey!))).toBe(true);
        expect(
          await prisma.importObservation.findMany({
            where: { artifactId: artifact.id },
          }),
        ).toEqual(claims);
        drain.mockRestore();
        const attached = await uploadBytes(upload, bytes);
        expect(
          await prisma.importSessionArtifact.findUniqueOrThrow({
            where: { id: attached.attachmentId },
          }),
        ).toMatchObject({ state: "ATTACHED", artifactId: artifact.id });
        const rematerialized = await prisma.importArtifact.findUniqueOrThrow({
          where: { id: artifact.id },
        });
        expect(rematerialized).toMatchObject({
          documentSha256: artifact.documentSha256,
          state: "RAW_READY",
          verifiedBytes: bytes.length,
        });
        expect(rematerialized.storageKey).not.toBe(before.storageKey);
        expect(existsSync(join(root, before.storageKey!))).toBe(false);
        expect(
          await prisma.importArtifact.findMany({
            where: { tenantId, documentSha256: artifact.documentSha256 },
          }),
        ).toEqual([rematerialized]);
        expect(
          await prisma.importObservation.findMany({
            where: { artifactId: artifact.id },
          }),
        ).toEqual(claims);
        expect(await prisma.expense.findMany({ where: { tenantId } })).toEqual(
          finances,
        );
        expect(
          await prisma.cashFlowEntry.findMany({ where: { tenantId } }),
        ).toEqual(flows);
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      } finally {
        drain.mockRestore();
        purge.mockRestore();
        txSpy.mockRestore();
      }
    }));

  it.each(["cancel", "delete", "timeout", "unavailable"] as const)(
    "revalidates %s at the purge wait barrier and keeps failed-upload cleanup",
    async (action) =>
      withVault(async ({ root, upload, purger }) => {
        const { bytes, artifact, expense } = await pendingClaimedPurge(root);
        const { reserved, attachmentId } = await reserveBytes(upload, bytes);
        let entered!: () => void;
        let release!: () => void;
        const arrived = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const actual = purger.purge.bind(purger);
        const spy = jest
          .spyOn(purger, "purge")
          .mockImplementation(async (target) => {
            entered();
            await barrier;
            if (action === "timeout") return "DRAIN_TIMEOUT";
            if (action === "unavailable")
              throw new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" });
            return actual(target);
          });
        const pending = upload
          .upload(
            auth,
            reserved.id,
            attachmentId,
            bytes.length,
            Readable.from([bytes]),
            {},
          )
          .then(
            (view) => ({ view, failure: undefined }),
            (failure: unknown) => ({ view: undefined, failure }),
          );
        await arrived;
        // A separate writer succeeding here proves the uploader has exited its tx.
        const waiting = await prisma.importSessionArtifact.findUniqueOrThrow({
          where: { id: attachmentId },
        });
        expect(waiting).toMatchObject({
          state: "RESERVED",
          verifiedAt: null,
          uploadGeneration: 2,
        });
        if (action === "cancel")
          await service.cancel(
            auth,
            reserved.id,
            { expectedRevision: reserved.revision },
            {},
          );
        if (action === "delete")
          await prisma.expense.delete({ where: { id: expense.id } });
        release();
        const result = await pending;
        const final = await prisma.importSessionArtifact.findUniqueOrThrow({
          where: { id: attachmentId },
        });
        if (action === "delete") {
          expect(result.failure).toBeUndefined();
          expect(final.state).toBe("ATTACHED");
          expect(final.artifactId).not.toBe(artifact.id);
          expect(
            await prisma.importArtifact.findUnique({
              where: { id: artifact.id },
            }),
          ).toBeNull();
        } else {
          expect(result.failure).toMatchObject({
            code:
              action === "unavailable"
                ? "CAPABILITY_DISABLED"
                : action === "timeout"
                  ? "RETRYABLE_WRITE_CONFLICT"
                  : "LEASE_CONFLICT",
          });
          expect(final.temporaryPurgePending).toBe(true);
          expect(final.artifactId).toBeNull();
          spy.mockRestore();
          expect(
            await purger.purge({
              kind: "ref",
              tenantId,
              ownerProjectId: projectId,
              id: attachmentId,
            }),
          ).toBe("PURGED");
          expect(existsSync(join(root, waiting.temporaryStorageKey!))).toBe(
            false,
          );
        }
        spy.mockRestore();
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      }),
  );

  it("two same-byte callers share the completed claimed purge, never its pending storage", async () =>
    withVault(async ({ root, upload, purger }) => {
      const { bytes, artifact } = await pendingClaimedPurge(root);
      const user = await prisma.user.create({
        data: {
          tenantId,
          username: randomUUID(),
          name: "second uploader",
          role: "ADMIN",
        },
      });
      const secondAuth = mintImportAuthContext({
        tenantId,
        userId: user.id,
        presentedSessionVersion: 0,
        tokenExpiresAt: auth.tokenExpiresAt,
      });
      const first = await reserveBytes(upload, bytes);
      const second = await reserveBytes(upload, bytes, secondAuth);
      let entered!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actual = purger.purge.bind(purger);
      let arrivals = 0;
      jest.spyOn(purger, "purge").mockImplementation(async (target) => {
        if (++arrivals === 2) entered();
        await barrier;
        return actual(target);
      });
      const pending = [
        upload.upload(
          auth,
          first.reserved.id,
          first.attachmentId,
          bytes.length,
          Readable.from([bytes]),
          {},
        ),
        upload.upload(
          secondAuth,
          second.reserved.id,
          second.attachmentId,
          bytes.length,
          Readable.from([bytes]),
          {},
        ),
      ];
      await arrived;
      await expect(
        upload.upload(
          auth,
          first.reserved.id,
          first.attachmentId,
          bytes.length,
          Readable.from([bytes]),
          {},
        ),
      ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
      release();
      await Promise.all(pending);
      const refs = await prisma.importSessionArtifact.findMany({
        where: { id: { in: [first.attachmentId, second.attachmentId] } },
      });
      expect(refs).toHaveLength(2);
      expect(
        refs.every(
          (ref) => ref.state === "ATTACHED" && ref.artifactId === artifact.id,
        ),
      ).toBe(true);
      expect(refs.filter((ref) => ref.temporaryPurgePending)).toHaveLength(1);
      expect(
        await prisma.importArtifact.count({
          where: { tenantId, documentSha256: artifact.documentSha256 },
        }),
      ).toBe(1);
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    }));

  it.each([
    { kind: "Expense", release: "cancel" },
    { kind: "Receipt", release: "cancel" },
    { kind: "Expense", release: "expiry" },
    { kind: "Receipt", release: "expiry" },
  ] as const)(
    "last $kind claim retirement preserves only authorized shared originals until $release; re-upload extracts fresh identity",
    async ({ kind, release }) =>
      withVault(
        async ({ root, upload, content, extraction, purger, reaper }) => {
          const created = await create();
          const bytes = Buffer.from(
            "date,title,amount\n2026-10-01,Identity fixture,206.96\n",
          );
          const { artifact, ref, material } = await attachCsv(
            created.view.id,
            bytes,
          );
          const second = await create();
          const shared = await prisma.importSessionArtifact.create({
            data: {
              tenantId,
              ownerProjectId: projectId,
              sessionId: second.view.id,
              artifactId: artifact.id,
              position: 0,
              fileName: "shared.csv",
              declaredMime: "text/csv",
              declaredBytes: bytes.length,
              reservedBytes: 0,
              state: "ATTACHED",
              verifiedAt: current,
            },
          });
          const storageKey = `t/${ref.id}/g2/blob`;
          mkdirSync(join(root, "t", ref.id, "g2"), {
            recursive: true,
            mode: 0o700,
          });
          writeFileSync(join(root, storageKey), bytes, { mode: 0o600 });
          await prisma.importArtifact.update({
            where: { id: artifact.id },
            data: { storageKey },
          });
          const finance =
            kind === "Expense"
              ? await new ExpenseService(
                  prisma,
                  new ConciliacaoService(prisma),
                ).create(tenantId, projectId, {
                  tipoDespesa: ExpenseType.OUTROS,
                  valor: 206.96,
                  quantidade: 1,
                  formaPagamento: PaymentForm.A_VISTA,
                  status: "PLANEJADO",
                })
              : await new ReceiptService(prisma, {} as never).create(
                  tenantId,
                  projectId,
                  {
                    valor: 206.96,
                    data: "2026-10-10T12:00:00.000Z",
                    tipo: "PAGAMENTO",
                    status: "PREVISTO",
                  },
                );
          await prisma.importObservation.update({
            where: { id: material.observations[0].id },
            data: {
              canonicalProjectId: projectId,
              canonicalExpenseId: kind === "Expense" ? finance.id : null,
              canonicalReceiptId: kind === "Receipt" ? finance.id : null,
              claimReceiptJson: "{}",
              claimedAt: current,
            },
          });
          if (kind === "Expense")
            await prisma.expense.delete({ where: { id: finance.id } });
          else await prisma.receipt.delete({ where: { id: finance.id } });
          const retired = await prisma.importArtifact.findUniqueOrThrow({
            where: { id: artifact.id },
          });
          expect(retired).toMatchObject({
            documentSha256: null,
            state: "PURGING",
            parserVersion: null,
            extractionJson: null,
            leaseSessionId: null,
            storageKey,
          });
          const stale = await service.getSession(auth, created.view.id);
          expect(stale.state).toBe("REVIEW_REQUIRED");
          expect(stale.attachments[0].canAnalyze).toBe(false);
          const stored = await prisma.importSession.findUniqueOrThrow({
            where: { id: created.view.id },
          });
          expect(JSON.parse(stored.draftJson).scope).toEqual({
            observationIds: [],
            pendingAttachmentIds: [ref.id],
          });
          expect((await service.getSession(auth, second.view.id)).state).toBe(
            "REVIEW_REQUIRED",
          );
          await expect(
            extraction.analyzeAttached(
              auth,
              created.view.id,
              ref.id,
              {
                expectedRevision: stale.revision,
              },
              {},
            ),
          ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
          const read = (sessionId: string, refId: string) =>
            content.download(auth, sessionId, refId, async (source) => {
              const chunks: Buffer[] = [];
              for await (const chunk of source) chunks.push(Buffer.from(chunk));
              return Buffer.concat(chunks);
            });
          expect(await read(created.view.id, ref.id)).toEqual(bytes);
          expect(await read(second.view.id, shared.id)).toEqual(bytes);
          await expect(read(created.view.id, shared.id)).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
          expect(
            await purger.purge({
              kind: "artifact",
              tenantId,
              ownerProjectId: projectId,
              id: artifact.id,
            }),
          ).toBe("NOT_ELIGIBLE");
          const fresh = await uploadBytes(upload, bytes);
          const freshRef = await prisma.importSessionArtifact.findUniqueOrThrow(
            {
              where: { id: fresh.attachmentId },
            },
          );
          expect(freshRef.artifactId).not.toBe(artifact.id);
          await extraction.analyzeAttached(
            auth,
            fresh.view.id,
            fresh.attachmentId,
            { expectedRevision: fresh.view.revision },
            {},
          );
          const observations = await prisma.importObservation.findMany({
            where: { artifactId: freshRef.artifactId! },
          });
          expect(observations).toHaveLength(1);
          expect(observations[0].id).not.toBe(material.observations[0].id);
          expect(observations[0].canonicalExpenseId).toBeNull();
          expect(observations[0].canonicalReceiptId).toBeNull();
          if (release === "cancel") {
            for (const sessionId of [created.view.id, second.view.id]) {
              const view = await service.getSession(auth, sessionId);
              await service.cancel(
                auth,
                sessionId,
                { expectedRevision: view.revision },
                {},
              );
            }
            expect(
              await purger.purge({
                kind: "artifact",
                tenantId,
                ownerProjectId: projectId,
                id: artifact.id,
              }),
            ).toBe("PURGED");
          } else {
            current = new Date(stored.expiresAt.getTime() + 1);
            await expect(read(created.view.id, ref.id)).rejects.toMatchObject({
              code: "NOT_FOUND",
            });
            const result = await reaper.runCycle({
              tenantId,
              ownerProjectId: projectId,
              limit: 16,
            });
            expect(result.purges).toContainEqual({
              target: {
                kind: "artifact",
                tenantId,
                ownerProjectId: projectId,
                id: artifact.id,
              },
              outcome: "PURGED",
            });
          }
          expect(existsSync(join(root, storageKey))).toBe(false);
          expect(
            await prisma.importArtifact.findUnique({
              where: { id: artifact.id },
            }),
          ).toBeNull();
          expect(await prisma.$queryRaw`PRAGMA foreign_keys`).toEqual([
            { foreign_keys: 1n },
          ]);
          expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
        },
      ),
  );

  it("real finalize drains claimed PURGING outside the writer and reuses observation/receipt identity", async () =>
    withVault(async ({ root, upload, extraction, purger }) => {
      const created = await create();
      const bytes = Buffer.from(
        "date,title,amount\n2026-10-01,Claimed purge fixture,206.96\n",
      );
      const { artifact, ref, material } = await attachCsv(
        created.view.id,
        bytes,
      );
      const expense = await new ExpenseService(
        prisma,
        new ConciliacaoService(prisma),
      ).create(tenantId, projectId, {
        tipoDespesa: ExpenseType.OUTROS,
        valor: 206.96,
        quantidade: 1,
        formaPagamento: PaymentForm.A_VISTA,
        status: "PLANEJADO",
      });
      await prisma.importObservation.update({
        where: { id: material.observations[0].id },
        data: {
          canonicalProjectId: projectId,
          canonicalExpenseId: expense.id,
          canonicalIndex: 0,
          claimReceiptJson: '{"kind":"SESSION"}',
          claimedAt: current,
        },
      });
      const observation = await prisma.importObservation.findUniqueOrThrow({
        where: { id: material.observations[0].id },
      });
      const storageKey = `t/${ref.id}/g2/blob`;
      mkdirSync(join(root, "t", ref.id, "g2"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(join(root, storageKey), bytes, { mode: 0o600 });
      await prisma.importArtifact.update({
        where: { id: artifact.id },
        data: { storageKey },
      });
      await service.cancel(
        auth,
        created.view.id,
        { expectedRevision: created.view.revision },
        {},
      );
      await prisma.importArtifact.update({
        where: { id: artifact.id },
        data: { state: "PURGING" },
      });
      const purge = jest.spyOn(purger, "purge");
      const fresh = await uploadBytes(upload, bytes);
      expect(purge).toHaveBeenCalledWith({
        kind: "artifact",
        tenantId,
        ownerProjectId: projectId,
        id: artifact.id,
      });
      const freshRef = await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: fresh.attachmentId },
      });
      expect(freshRef.artifactId).toBe(artifact.id);
      expect(existsSync(join(root, storageKey))).toBe(false);
      expect(
        await prisma.importArtifact.findUniqueOrThrow({
          where: { id: artifact.id },
        }),
      ).toMatchObject({
        documentSha256: artifact.documentSha256,
        state: "RAW_READY",
        extractionJson: null,
        storageKey: expect.not.stringMatching(new RegExp(ref.id)),
      });
      await extraction.analyzeAttached(
        auth,
        fresh.view.id,
        fresh.attachmentId,
        { expectedRevision: fresh.view.revision },
        {},
      );
      const after = await prisma.importObservation.findUniqueOrThrow({
        where: { id: observation.id },
      });
      expect(after).toMatchObject({
        canonicalExpenseId: expense.id,
        claimReceiptJson: observation.claimReceiptJson,
      });
      expect(
        await prisma.importObservation.count({
          where: { artifactId: artifact.id },
        }),
      ).toBe(1);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(1);
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    }));

  // Immutable extraction fixture, not a financial write: normalize through the
  // production parser/materializer, then exercise real lifecycle services.
  const attachCsv = async (
    sessionId: string,
    bytes: Buffer = Buffer.from(
      `date,title,amount\n2026-10-01,Private ${randomUUID()},1.00\n`,
    ),
  ) => {
    const session = await prisma.importSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const extraction = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes,
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
        verifiedBytes: bytes.length,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        parserVersion: extraction.parserVersion,
        extractionJson: JSON.stringify(extraction),
      },
    });
    const ref = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId,
        artifactId: artifact.id,
        position: 0,
        fileName: "private.csv",
        declaredMime: "text/csv",
        declaredBytes: bytes.length,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: current,
      },
    });
    const material = buildImportMaterialization({
      session,
      attachment: ref,
      artifact,
      extraction,
      observations: [],
      draft: {
        ...JSON.parse(EMPTY_DRAFT_JSON),
        scope: { observationIds: [], pendingAttachmentIds: [ref.id] },
      },
      newIds: new Map(
        extraction.occurrences.map((occurrence) => [
          occurrence.reference,
          { observationId: randomUUID(), lineId: randomUUID() },
        ]),
      ),
    });
    for (const observation of material.observations)
      await prisma.importObservation.create({ data: observation });
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(material.draft) },
    });
    return { session, artifact, ref, material, extraction };
  };

  const confirmedAtEffectiveExpiry = async () => {
    const created = await create();
    const attached = await attachCsv(
      created.view.id,
      Buffer.from(
        "date,title,amount\n2026-10-01,Expiry lifecycle fixture,7.77\n",
      ),
    );
    const financialRequestId = randomUUID();
    await prisma.importArtifact.update({
      where: { id: attached.artifact.id },
      data: {
        state: "ANALYZING",
        parseGeneration: 5,
        leaseSessionId: created.view.id,
        leaseSessionVersion: 0,
        leaseTokenExpiresAt: new Date(current.getTime() + 60_000),
        leaseExpiresAt: new Date(current.getTime() + 60_000),
      },
    });
    await prisma.importSessionArtifact.update({
      where: { id: attached.ref.id },
      data: {
        uploadGeneration: 7,
        uploadSessionVersion: 0,
        uploadTokenExpiresAt: new Date(current.getTime() + 60_000),
        uploadLeaseExpiresAt: new Date(current.getTime() + 60_000),
      },
    });
    const confirmed = await prisma.importSession.update({
      where: { id: created.view.id },
      data: {
        state: "CONFIRMED",
        revision: 9,
        expiresAt: current,
        draftJson: JSON.stringify(attached.material.draft),
        searchJson: '{"kind":"private-search"}',
        proposalJson: '{"kind":"private-proposal"}',
        proposalHash: "a".repeat(64),
        preflightHash: "b".repeat(64),
        challengeJson: '{"kind":"private-challenge"}',
        prepareLeaseJson: '{"kind":"private-lease"}',
        prepareGeneration: 11,
        financialRequestId,
        confirmedRevision: 8,
        confirmedSessionVersion: 0,
        confirmedAt: new Date(current.getTime() - 1),
      },
    });
    const workflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      {
        writesEnabled: () => true,
        newImportFormats: capability.newImportFormats.bind(capability),
      },
      verifier,
      new CardPurchaseBatchAdapter(
        new ExpenseService(prisma, new ConciliacaoService(prisma)),
        new ConciliacaoService(prisma),
        clock,
      ),
      gate as never,
      raw as never,
    );
    return { ...attached, confirmed, financialRequestId, workflow };
  };

  const financialInventory = () =>
    Promise.all([
      prisma.expense.count({ where: { tenantId } }),
      prisma.cashFlowEntry.count({ where: { tenantId } }),
      prisma.receipt.count({ where: { tenantId } }),
      prisma.rateioAllocation.count({ where: { tenantId } }),
      prisma.crossProjectSettlement.count({ where: { tenantId } }),
      prisma.importedInvoiceLiquidation.count({ where: { tenantId } }),
    ]);

  it("execute at the exact CONFIRMED expiry commits the complete terminal lifecycle before SESSION_EXPIRED", async () => {
    raw.abortOwned.mockClear();
    const fixture = await confirmedAtEffectiveExpiry();
    const beforeFinance = await financialInventory();
    const exactClaim = {
      tenantId,
      ownerProjectId: projectId,
      sessionId: fixture.confirmed.id,
      artifactId: fixture.artifact.id,
      parseGeneration: 5,
    };

    await expect(
      fixture.workflow.execute(
        auth,
        fixture.confirmed.id,
        { financialRequestId: fixture.financialRequestId },
        {},
      ),
    ).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      sessionId: fixture.confirmed.id,
      currentRevision: 9,
      retryable: false,
    });

    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: fixture.confirmed.id },
      }),
    ).toMatchObject({
      state: "EXPIRED",
      revision: 10,
      closedAt: current,
      draftJson: EMPTY_DRAFT_JSON,
      searchJson: null,
      proposalJson: null,
      proposalHash: "a".repeat(64),
      preflightHash: null,
      challengeJson: null,
      prepareLeaseJson: null,
      prepareGeneration: 12,
      financialRequestId: fixture.financialRequestId,
      confirmedRevision: 8,
      confirmedSessionVersion: 0,
      confirmedAt: new Date(current.getTime() - 1),
      receiptJson: null,
    });
    expect(
      await prisma.importSessionArtifact.findUnique({
        where: { id: fixture.ref.id },
      }),
    ).toBeNull();
    expect(
      await prisma.importArtifact.findUnique({
        where: { id: fixture.artifact.id },
      }),
    ).toBeNull();
    expect(
      await prisma.importObservation.count({
        where: { artifactId: fixture.artifact.id },
      }),
    ).toBe(0);
    expect(await financialInventory()).toEqual(beforeFinance);
    expect(raw.abortOwned).toHaveBeenCalledTimes(1);
    expect(raw.abortOwned).toHaveBeenCalledWith([exactClaim], "EXPIRE");
  });

  it("rolls the expiry transition back when terminal attachment cleanup fails", async () => {
    raw.abortOwned.mockClear();
    const fixture = await confirmedAtEffectiveExpiry();
    const beforeFinance = await financialInventory();
    const trigger = `qa_expiry_cleanup_${fixture.ref.id.replaceAll("-", "_")}`;
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${trigger}"
      BEFORE UPDATE OF state ON import_session_artifacts
      WHEN OLD.id = '${fixture.ref.id}'
      BEGIN
        SELECT RAISE(ABORT, 'qa forced expiry cleanup failure');
      END
    `);
    try {
      const failure = await fixture.workflow
        .execute(
          auth,
          fixture.confirmed.id,
          { financialRequestId: fixture.financialRequestId },
          {},
        )
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "P2003",
        meta: { field_name: "foreign key" },
      });
      expect(
        await prisma.importSession.findUniqueOrThrow({
          where: { id: fixture.confirmed.id },
        }),
      ).toEqual(fixture.confirmed);
      expect(
        await prisma.importSessionArtifact.findUniqueOrThrow({
          where: { id: fixture.ref.id },
        }),
      ).toMatchObject({
        state: "ATTACHED",
        uploadGeneration: 7,
        uploadSessionVersion: 0,
        uploadTokenExpiresAt: new Date(current.getTime() + 60_000),
        uploadLeaseExpiresAt: new Date(current.getTime() + 60_000),
      });
      expect(
        await prisma.importArtifact.findUniqueOrThrow({
          where: { id: fixture.artifact.id },
        }),
      ).toMatchObject({
        state: "ANALYZING",
        parseGeneration: 5,
        leaseSessionId: fixture.confirmed.id,
        leaseSessionVersion: 0,
        leaseTokenExpiresAt: new Date(current.getTime() + 60_000),
        leaseExpiresAt: new Date(current.getTime() + 60_000),
      });
      expect(
        await prisma.importObservation.count({
          where: { artifactId: fixture.artifact.id },
        }),
      ).toBe(1);
      expect(await financialInventory()).toEqual(beforeFinance);
      expect(raw.abortOwned).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`);
    }
  });

  it("execute/reaper concurrency and execute retry converge on one cleanup and one exact post-commit abort", async () => {
    raw.abortOwned.mockClear();
    const fixture = await confirmedAtEffectiveExpiry();
    const reaper = new VaultReaper(prisma, clock, gate as never, raw as never);
    const execute = () =>
      fixture.workflow
        .execute(
          auth,
          fixture.confirmed.id,
          { financialRequestId: fixture.financialRequestId },
          {},
        )
        .catch((error) => error);

    const [executeError] = await Promise.all([
      execute(),
      reaper.runCycle({
        tenantId,
        ownerProjectId: projectId,
        limit: 16,
      }),
    ]);
    expect(executeError).toMatchObject({ code: "SESSION_EXPIRED" });
    const settled = await prisma.importSession.findUniqueOrThrow({
      where: { id: fixture.confirmed.id },
    });
    expect(settled).toMatchObject({
      state: "EXPIRED",
      revision: 10,
      draftJson: EMPTY_DRAFT_JSON,
      searchJson: null,
      proposalJson: null,
      preflightHash: null,
      prepareGeneration: 12,
    });
    const callsAfterRace = raw.abortOwned.mock.calls.slice();
    await expect(
      fixture.workflow.execute(
        auth,
        fixture.confirmed.id,
        { financialRequestId: fixture.financialRequestId },
        {},
      ),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: fixture.confirmed.id },
      }),
    ).toEqual(settled);
    expect(raw.abortOwned.mock.calls).toEqual(callsAfterRace);
    expect(callsAfterRace).toEqual([
      [
        [
          {
            tenantId,
            ownerProjectId: projectId,
            sessionId: fixture.confirmed.id,
            artifactId: fixture.artifact.id,
            parseGeneration: 5,
          },
        ],
        "EXPIRE",
      ],
    ]);
  });

  it("physically purges temporary bytes and restores quota after execute-time expiry", async () =>
    withVault(async ({ root, reaper }) => {
      raw.abortOwned.mockClear();
      const fixture = await confirmedAtEffectiveExpiry();
      const temporaryStorageKey = `t/${fixture.ref.id}`;
      const blobKey = `${temporaryStorageKey}/g7/blob`;
      mkdirSync(join(root, "t", fixture.ref.id, "g7"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(join(root, blobKey), Buffer.from("private bytes"), {
        mode: 0o600,
      });
      await prisma.importSessionArtifact.update({
        where: { id: fixture.ref.id },
        data: {
          temporaryStorageKey,
          reservedBytes: 13,
        },
      });

      await expect(
        fixture.workflow.execute(
          auth,
          fixture.confirmed.id,
          { financialRequestId: fixture.financialRequestId },
          {},
        ),
      ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
      expect(
        await prisma.importSessionArtifact.findUniqueOrThrow({
          where: { id: fixture.ref.id },
        }),
      ).toMatchObject({
        state: "RELEASED",
        temporaryPurgePending: true,
        reservedBytes: 13,
      });
      expect(existsSync(join(root, temporaryStorageKey))).toBe(true);
      expect(existsSync(join(root, blobKey))).toBe(true);

      const cycle = await reaper.runCycle({
        tenantId,
        ownerProjectId: projectId,
        limit: 16,
      });
      expect(cycle.purges).toContainEqual({
        target: {
          kind: "ref",
          tenantId,
          ownerProjectId: projectId,
          id: fixture.ref.id,
        },
        outcome: "PURGED",
      });
      expect(existsSync(join(root, temporaryStorageKey))).toBe(false);
      expect(existsSync(join(root, blobKey))).toBe(false);
      expect(
        await prisma.importSessionArtifact.findUnique({
          where: { id: fixture.ref.id },
        }),
      ).toBeNull();
      const quota = await prisma.importSessionArtifact.aggregate({
        where: { tenantId },
        _sum: { reservedBytes: true },
      });
      expect(quota._sum.reservedBytes ?? 0).toBe(0);
    }));

  it("retains shared artifact evidence while releasing only the expired session reference", async () => {
    raw.abortOwned.mockClear();
    const fixture = await confirmedAtEffectiveExpiry();
    const active = await create();
    const shared = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId: active.view.id,
        artifactId: fixture.artifact.id,
        position: 0,
        fileName: "shared.csv",
        declaredMime: "text/csv",
        declaredBytes: fixture.ref.declaredBytes,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: current,
      },
    });

    await expect(
      fixture.workflow.execute(
        auth,
        fixture.confirmed.id,
        { financialRequestId: fixture.financialRequestId },
        {},
      ),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(
      await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: fixture.ref.id },
      }),
    ).toMatchObject({ state: "RELEASED", uploadGeneration: 8 });
    expect(
      await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: shared.id },
      }),
    ).toMatchObject({
      state: "ATTACHED",
      uploadGeneration: 0,
      artifactId: fixture.artifact.id,
    });
    expect(
      await prisma.importObservation.count({
        where: { artifactId: fixture.artifact.id },
      }),
    ).toBe(1);
  });

  it("expires a confirmed empty attachment/lease set without inventing claims or finance", async () => {
    raw.abortOwned.mockClear();
    const fixture = await confirmedAtEffectiveExpiry();
    await prisma.importArtifact.update({
      where: { id: fixture.artifact.id },
      data: {
        leaseSessionId: null,
        leaseSessionVersion: null,
        leaseTokenExpiresAt: null,
        leaseExpiresAt: null,
      },
    });
    await prisma.importObservation.deleteMany({
      where: { artifactId: fixture.artifact.id },
    });
    await prisma.importSessionArtifact.delete({
      where: { id: fixture.ref.id },
    });
    expect(
      await prisma.importArtifact.findUnique({
        where: { id: fixture.artifact.id },
      }),
    ).toBeNull();
    await prisma.importSession.update({
      where: { id: fixture.confirmed.id },
      data: {
        state: "CONFIRMED",
        revision: 9,
        draftJson: EMPTY_DRAFT_JSON,
        searchJson: fixture.confirmed.searchJson,
        proposalJson: fixture.confirmed.proposalJson,
        proposalHash: fixture.confirmed.proposalHash,
        preflightHash: fixture.confirmed.preflightHash,
        challengeJson: fixture.confirmed.challengeJson,
        prepareLeaseJson: fixture.confirmed.prepareLeaseJson,
        prepareGeneration: 11,
        closedAt: null,
      },
    });
    const beforeFinance = await financialInventory();

    await expect(
      fixture.workflow.execute(
        auth,
        fixture.confirmed.id,
        { financialRequestId: fixture.financialRequestId },
        {},
      ),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: fixture.confirmed.id },
      }),
    ).toMatchObject({
      state: "EXPIRED",
      revision: 10,
      draftJson: EMPTY_DRAFT_JSON,
      prepareGeneration: 12,
    });
    expect(await financialInventory()).toEqual(beforeFinance);
    expect(raw.abortOwned).toHaveBeenCalledTimes(1);
    expect(raw.abortOwned).toHaveBeenCalledWith([], "EXPIRE");
  });

  it.each([
    { kind: "Expense", deletion: "soft" },
    { kind: "Expense", deletion: "hard" },
    { kind: "Receipt", deletion: "soft" },
    { kind: "Receipt", deletion: "hard" },
  ] as const)(
    "$kind $deletion canonical deletion denies cached hash reuse before reaper and removes linkage after real fenced purge",
    async ({ kind, deletion }) => {
      const root = mkdtempSync(join(tmpdir(), "maria-fenced-linkage-"));
      const registry = new VaultFdRegistry();
      // Physical boot/lock ownership is a separate platform concern. Everything
      // after the ON boundary uses the real storage, registry, services and DB.
      const runtime: VaultRuntime = {
        config: {
          configured: true,
          rootDir: root,
          lockFd: 3,
          idleTimeoutMs: 1000,
          headroomBytes: 1,
          drainTimeoutMs: 1000,
        },
        lockIdentity: { dev: 1n, ino: 1n },
      };
      const boot = {
        runtime: () => runtime,
        stopped: new AbortController().signal,
        recheckLock: async () => ({ ok: true, runtime }),
      } as VaultBootHandle;
      const storage = new VaultStorage(boot, registry, clock);
      const purger = new PurgeCoordinator(
        prisma,
        clock,
        boot,
        registry,
        storage,
        1000,
      );
      const localGate = {
        boot,
        registry,
        storage,
        requirePurger: () => purger,
      };
      const upload = new ImportUploadService(
        prisma,
        clock,
        capability,
        verifier as never,
        localGate as never,
      );
      try {
        mkdirSync(join(root, "t"), { mode: 0o700 });
        mkdirSync(join(root, "trash"), { mode: 0o700 });
        const first = await create();
        const bytes = Buffer.from(
          `date,title,amount\n2026-10-01,Canonical ${kind} ${deletion} fixture,206.96\n`,
        );
        const { artifact, ref, material } = await attachCsv(
          first.view.id,
          bytes,
        );
        const temporarySession = await create();
        const temporaryRefId = randomUUID();
        const temporaryStorageKey = `t/${temporaryRefId}`;
        const temporaryRef = await prisma.importSessionArtifact.create({
          data: {
            id: temporaryRefId,
            tenantId,
            ownerProjectId: projectId,
            sessionId: temporarySession.view.id,
            artifactId: artifact.id,
            position: 0,
            fileName: "temporary.csv",
            declaredMime: "text/csv",
            declaredBytes: bytes.length,
            reservedBytes: 0,
            state: "RELEASED",
            temporaryStorageKey,
            temporaryPurgePending: true,
            releasedAt: current,
          },
        });
        const storageKey = `t/${ref.id}/g2/blob`;
        mkdirSync(join(root, "t", ref.id), { mode: 0o700 });
        mkdirSync(join(root, "t", ref.id, "g2"), { mode: 0o700 });
        mkdirSync(join(root, temporaryStorageKey), { mode: 0o700 });
        mkdirSync(join(root, temporaryStorageKey, "g2"), { mode: 0o700 });
        writeFileSync(join(root, storageKey), bytes, { mode: 0o600 });
        writeFileSync(join(root, temporaryStorageKey, "g2", "blob"), bytes, {
          mode: 0o600,
        });
        await prisma.importArtifact.update({
          where: { id: artifact.id },
          data: { storageKey },
        });
        const finance =
          kind === "Expense"
            ? await new ExpenseService(
                prisma,
                new ConciliacaoService(prisma),
              ).create(tenantId, projectId, {
                tipoDespesa: ExpenseType.OUTROS,
                valor: 206.96,
                quantidade: 1,
                titulo: "Fenced canonical fixture",
                formaPagamento: PaymentForm.A_VISTA,
                status: "PLANEJADO",
              })
            : await new ReceiptService(prisma, {} as never).create(
                tenantId,
                projectId,
                {
                  valor: 206.96,
                  data: "2026-10-10T12:00:00.000Z",
                  tipo: "PAGAMENTO",
                  status: "PREVISTO",
                  descricao: "Fenced canonical fixture",
                },
              );
        await prisma.importObservation.update({
          where: { id: material.observations[0].id },
          data: {
            evidenceJson: "{}",
            claimVersion: 1,
            canonicalProjectId: projectId,
            canonicalExpenseId: kind === "Expense" ? finance.id : null,
            canonicalReceiptId: kind === "Receipt" ? finance.id : null,
            canonicalIndex: kind === "Expense" ? 0 : null,
            claimSessionId: first.view.id,
            claimReceiptJson: '{"kind":"SESSION"}',
            claimedAt: current,
          },
        });
        // Terminal, released association is not consent to retain the original.
        await service.cancel(
          auth,
          first.view.id,
          { expectedRevision: first.view.revision },
          {},
        );
        expect(
          (
            await prisma.importSessionArtifact.findUniqueOrThrow({
              where: { id: ref.id },
            })
          ).state,
        ).toBe("RELEASED");
        const readFinance = () =>
          kind === "Expense"
            ? prisma.expense.findUniqueOrThrow({ where: { id: finance.id } })
            : prisma.receipt.findUniqueOrThrow({ where: { id: finance.id } });
        const financialBefore = await readFinance();
        const flowWhere =
          kind === "Expense"
            ? { expenseId: finance.id }
            : { receiptId: finance.id };
        const flows = await prisma.cashFlowEntry.findMany({
          where: flowWhere,
        });
        if (deletion === "soft") {
          if (kind === "Expense")
            await prisma.expense.delete({ where: { id: finance.id } });
          else await prisma.receipt.delete({ where: { id: finance.id } });
          const tombstone = await readFinance();
          expect(tombstone).toEqual({
            ...financialBefore,
            deletedAt: expect.any(Date),
            updatedAt: expect.any(Date),
          });
          expect(
            await prisma.cashFlowEntry.findMany({
              where: flowWhere,
            }),
          ).toEqual(flows);
        } else {
          await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`DELETE FROM cash_flow_entries WHERE expense_id = ${finance.id} OR receipt_id = ${finance.id}`;
            if (kind === "Expense")
              await tx.$executeRaw`DELETE FROM expenses WHERE id = ${finance.id}`;
            else
              await tx.$executeRaw`DELETE FROM receipts WHERE id = ${finance.id}`;
          });
        }
        // Capture at the DELETE commit barrier: upload must not be what finally
        // revokes the old identity or extraction.
        const hashMatchesAtDelete = await prisma.importArtifact.findMany({
          where: { tenantId, documentSha256: artifact.documentSha256 },
        });
        const pending = await prisma.importArtifact.findUniqueOrThrow({
          where: { id: artifact.id },
        });
        // Upload is deliberately before ANY reaper invocation.
        const again = await create();
        const uploadId = randomUUID();
        const reserved = await upload.reserve(
          auth,
          again.view.id,
          {
            expectedRevision: again.view.revision,
            files: [
              {
                id: uploadId,
                fileName: "same.csv",
                declaredBytes: bytes.length,
                mime: "text/csv",
              },
            ],
          },
          {},
        );
        await upload.upload(
          auth,
          again.view.id,
          uploadId,
          bytes.length,
          Readable.from([bytes]),
          {},
        );
        const uploadedRef =
          await prisma.importSessionArtifact.findUniqueOrThrow({
            where: { id: uploadId },
          });
        expect(uploadedRef.state).toBe("ATTACHED");
        expect(uploadedRef.artifactId).not.toBe(artifact.id);
        const fresh = await prisma.importArtifact.findUniqueOrThrow({
          where: { id: uploadedRef.artifactId! },
        });
        expect(fresh).toMatchObject({
          documentSha256: artifact.documentSha256,
          state: "RAW_READY",
          extractionJson: null,
          parserVersion: null,
        });
        expect(hashMatchesAtDelete).toEqual([]);
        expect(
          await prisma.importArtifact.findMany({
            where: { tenantId, documentSha256: artifact.documentSha256 },
          }),
        ).toEqual([fresh]);
        expect(
          await prisma.importObservation.findMany({
            where: { artifactId: artifact.id },
          }),
        ).toEqual([]);
        expect(pending).toMatchObject({
          state: "PURGING",
          storageKey,
          extractionJson: null,
          leaseSessionId: null,
          leaseSessionVersion: null,
          leaseExpiresAt: null,
          leaseTokenExpiresAt: null,
        });
        expect(pending.documentSha256).not.toBe(artifact.documentSha256);
        expect(existsSync(join(root, storageKey))).toBe(true);
        const fence = jest.spyOn(registry, "fence");
        const drain = jest.spyOn(registry, "abortAndDrain");
        expect(
          await purger.purge({
            kind: "artifact",
            tenantId,
            ownerProjectId: projectId,
            id: artifact.id,
          }),
        ).toBe("PURGED");
        expect(fence).toHaveBeenCalledWith(`A:${artifact.id}`);
        expect(drain).toHaveBeenCalledWith(`A:${artifact.id}`, 1000);
        expect(existsSync(join(root, storageKey))).toBe(false);
        expect(
          await prisma.importArtifact.findUniqueOrThrow({
            where: { id: artifact.id },
          }),
        ).toMatchObject({
          documentSha256: null,
          state: "PURGED",
          storageKey: null,
          extractionJson: null,
        });
        expect(
          await prisma.importSessionArtifact.findUnique({
            where: { id: temporaryRef.id },
          }),
        ).toMatchObject({
          temporaryStorageKey,
          temporaryPurgePending: true,
        });
        expect(existsSync(join(root, temporaryStorageKey))).toBe(true);
        expect(
          await purger.purge({
            kind: "ref",
            tenantId,
            ownerProjectId: projectId,
            id: temporaryRef.id,
          }),
        ).toBe("PURGED");
        expect(existsSync(join(root, temporaryStorageKey))).toBe(false);
        expect(
          await prisma.importSessionArtifact.findUnique({
            where: { id: temporaryRef.id },
          }),
        ).toBeNull();
        expect(
          await prisma.importArtifact.findUnique({
            where: { id: artifact.id },
          }),
        ).toBeNull();
        expect(
          await prisma.importSessionArtifact.count({
            where: { artifactId: artifact.id },
          }),
        ).toBe(0);
        expect(
          await prisma.importArtifact.findUnique({
            where: { id: fresh.id },
          }),
        ).toEqual(fresh);
        expect(await prisma.$queryRaw`PRAGMA foreign_keys`).toEqual([
          { foreign_keys: 1n },
        ]);
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
        expect(reserved.id).toBe(again.view.id);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("CANCELLED deletes unclaimed evidence only after the last live shared reference closes", async () => {
    const first = await create();
    const second = await create();
    const { artifact, ref, material } = await attachCsv(first.view.id);
    const shared = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId: second.view.id,
        artifactId: artifact.id,
        position: 0,
        fileName: ref.fileName,
        declaredMime: ref.declaredMime,
        declaredBytes: ref.declaredBytes,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: current,
      },
    });
    await prisma.importSession.update({
      where: { id: second.view.id },
      data: { draftJson: JSON.stringify(material.draft) },
    });
    const before = await prisma.importObservation.findMany({
      where: { artifactId: artifact.id },
    });
    expect(before).toHaveLength(1);
    expect(JSON.parse(before[0].evidenceJson).sourceDescription).toContain(
      "Private",
    );
    await service.cancel(
      auth,
      first.view.id,
      {
        expectedRevision: first.view.revision,
      },
      {},
    );
    expect(await service.getObservations(auth, first.view.id)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
      }),
    ).toEqual(before);
    await new VaultReaper(prisma, clock, gate as never, raw as never).runCycle({
      tenantId,
      ownerProjectId: projectId,
      limit: 16,
    });
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
      }),
    ).toEqual(before);
    expect(
      (await service.getObservations(auth, second.view.id)).items,
    ).toHaveLength(1);
    await service.cancel(
      auth,
      second.view.id,
      {
        expectedRevision: second.view.revision,
      },
      {},
    );
    expect(
      await prisma.importObservation.count({
        where: { artifactId: artifact.id },
      }),
    ).toBe(0);
    expect(await service.getObservations(auth, second.view.id)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await prisma.importSessionArtifact.findUnique({
        where: { id: shared.id },
      }),
    ).toBeNull();
    expect(
      await prisma.importArtifact.findUnique({
        where: { id: artifact.id },
      }),
    ).toBeNull();
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });

  it("EXPIRED reaper deletes unclaimed evidence at the existing seven-day expiry", async () => {
    const created = await create();
    const { artifact } = await attachCsv(created.view.id);
    const row = await prisma.importSession.findUniqueOrThrow({
      where: { id: created.view.id },
    });
    current = new Date(row.expiresAt.getTime() - 1);
    const reaper = new VaultReaper(prisma, clock, gate as never, raw as never);
    await reaper.runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
    expect(
      await prisma.importObservation.count({
        where: { artifactId: artifact.id },
      }),
    ).toBe(1);
    current = row.expiresAt;
    await reaper.runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
    expect(
      (
        await prisma.importSession.findUniqueOrThrow({
          where: { id: created.view.id },
        })
      ).state,
    ).toBe("EXPIRED");
    expect(
      await prisma.importObservation.count({
        where: { artifactId: artifact.id },
      }),
    ).toBe(0);
    expect(await service.getObservations(auth, created.view.id)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });

  it.each(["CANCELLED", "EXPIRED"] as const)(
    "reaper cleans historical %s evidence even after original/extraction purge",
    async (terminal) => {
      const created = await create();
      const { material } = await attachCsv(created.view.id);
      await service.cancel(
        auth,
        created.view.id,
        {
          expectedRevision: created.view.revision,
        },
        {},
      );
      // Legacy terminal fixture reproduces rows left by the previous cleanup.
      await prisma.importSession.update({
        where: { id: created.view.id },
        data: { state: terminal },
      });
      const legacyArtifact = await prisma.importArtifact.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          documentSha256: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
          verifiedBytes: 1,
          detectedFormat: "CSV",
          state: "PURGED",
        },
      });
      await prisma.importSessionArtifact.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          sessionId: created.view.id,
          artifactId: legacyArtifact.id,
          position: 0,
          fileName: "document",
          declaredMime: "text/csv",
          declaredBytes: 1,
          reservedBytes: 0,
          state: "RELEASED",
          releasedAt: current,
        },
      });
      for (const observation of material.observations)
        await prisma.importObservation.create({
          data: { ...observation, artifactId: legacyArtifact.id },
        });
      await new VaultReaper(
        prisma,
        clock,
        gate as never,
        raw as never,
      ).runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
      expect(
        await prisma.importObservation.count({
          where: { artifactId: legacyArtifact.id },
        }),
      ).toBe(0);
      expect(await service.getObservations(auth, created.view.id)).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    },
  );

  it("create/replay/reads write no finance and do not extend seven-day draft retention", async () => {
    const request = {
      version: 1,
      createRequestId: randomUUID(),
      cardId,
      consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
      consentAnalyze: true,
    };
    const first = await service.create(auth, request, {});
    const expiry = await prisma.importSession.findUniqueOrThrow({
      where: { id: first.view.id },
    });
    expect(expiry.expiresAt.getTime() - expiry.lastUserEditAt.getTime()).toBe(
      IMPORT_SESSION_LIMITS.draftRetentionSeconds * 1000,
    );
    expect((await service.create(auth, request, {})).created).toBe(false);
    current = new Date(current.getTime() + 3600000);
    await service.getSession(auth, first.view.id);
    const after = await prisma.importSession.findUniqueOrThrow({
      where: { id: first.view.id },
    });
    expect(after.expiresAt).toEqual(expiry.expiresAt);
    expect(after.lastUserEditAt).toEqual(expiry.lastUserEditAt);
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.receipt.count({ where: { tenantId } })).toBe(0);
  });

  it("cancellation uses the service and expiry uses the scoped runtime reaper", async () => {
    const cancelled = await create();
    await service.cancel(
      auth,
      cancelled.view.id,
      { expectedRevision: cancelled.view.revision },
      {},
    );
    expect((await service.getSession(auth, cancelled.view.id)).state).toBe(
      "CANCELLED",
    );
    const expired = await create();
    current = new Date(
      current.getTime() + IMPORT_SESSION_LIMITS.draftRetentionSeconds * 1000,
    );
    const reaper = new VaultReaper(prisma, clock, gate as never, raw as never);
    await reaper.runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
    expect(
      (
        await prisma.importSession.findUniqueOrThrow({
          where: { id: expired.view.id },
        })
      ).state,
    ).toBe("EXPIRED");
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
  });

  it("APPLIED recovery and execute replay depend on the immutable receipt, not retained draft/original", async () => {
    const created = await create();
    const financialRequestId = randomUUID();
    const receipt = {
      version: 1,
      sessionId: created.view.id,
      financialRequestId,
      confirmedRevision: 1,
      proposalHash: "a".repeat(64),
      appliedAt: current.toISOString(),
      continuationSessionId: null,
      items: [
        {
          lineId: "line-retention",
          outcome: "CREATED",
          sourceExpenseId: "purged-source-reference",
          targetExpenseIds: [],
          allocationIds: [],
          cashFlowEntryIds: ["removed-flow-reference"],
        },
      ],
      snapshot: {
        lines: [
          {
            lineId: "line-retention",
            titulo: "normalized purchase",
            dataCompra: "2026-10-01",
            totalCents: 100,
            sourceProjectId: projectId,
            targets: [],
            schedule: {
              version: 1,
              occurrences: [
                {
                  index: 0,
                  parcela: null,
                  valor: 100,
                  data: "2026-10-10",
                  invoiceDueMonth: "2026-10",
                },
              ],
            },
          },
        ],
        participantProjectIds: [projectId],
        createdEconomicTotalCents: 100,
        bankCashDeltaCents: 0,
        invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 100 }],
      },
    };
    // A durable terminal fixture: source rows may subsequently have been removed.
    await prisma.importSession.update({
      where: { id: created.view.id },
      data: {
        state: "APPLIED",
        financialRequestId,
        confirmedRevision: 1,
        confirmedSessionVersion: 0,
        confirmedAt: current,
        proposalHash: receipt.proposalHash,
        closedAt: current,
        receiptJson: JSON.stringify(receipt),
        draftJson: EMPTY_DRAFT_JSON,
        proposalJson: null,
        searchJson: null,
      },
    });
    const normalizedReceipt = { ...receipt, auditItems: [] };
    expect((await service.getResult(auth, created.view.id)).receipt).toEqual(
      normalizedReceipt,
    );
    const batches = { applyInTx: jest.fn(), prepareInTx: jest.fn() };
    const workflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      verifier,
      batches as never,
      gate as never,
      raw as never,
    );
    expect(
      await workflow.execute(auth, created.view.id, { financialRequestId }, {}),
    ).toEqual(normalizedReceipt);
    expect(batches.applyInTx).not.toHaveBeenCalled();
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
  });

  it.each([false, true])(
    "real prepare/consent/execute strips persisted drafts, releases refs and replays only the receipt (invoice-payment=%s)",
    async (deferred) => {
      const initialActivities = await prisma.userActivityLog.count({
        where: { tenantId },
      });
      const initialExpenses = await prisma.expense.count({
        where: { tenantId },
      });
      const initialFlows = await prisma.cashFlowEntry.count({
        where: { tenantId },
      });
      const created = await create();
      const bytes = Buffer.from(
        `date,title,amount\n2026-10-01,${deferred ? "Deferred Fixture" : "Fixture"} PARC 1/2,1.00\n${
          deferred ? "2026-10-02,PAGAMENTO EFETUADO private detail,-1.00\n" : ""
        }`,
      );
      const { session, artifact, ref, material, extraction } = await attachCsv(
        created.view.id,
        bytes,
      );
      const draft = {
        ...material.draft,
        questions: [],
        selectedLineIds: material.draft.lines.map((line) => line.id),
        lines: material.draft.lines.map((line) => ({
          ...line,
          amountMeaning: "TOTAL_PURCHASE" as const,
          amountCents: 200,
          installmentCount: 2,
          firstDueDate: "2026-10-10",
          targets: [],
          tipoDespesa: ExpenseType.OUTROS,
          decision: { kind: "CREATE" as const, acceptNaturalDuplicate: false },
        })),
      };
      await prisma.importSession.update({
        where: { id: session.id },
        data: { draftJson: JSON.stringify(draft) },
      });
      const conciliacao = new ConciliacaoService(prisma);
      const expenses = new ExpenseService(prisma, conciliacao);
      const batches = new CardPurchaseBatchAdapter(
        expenses,
        conciliacao,
        clock,
      );
      const workflow = new ImportSessionWorkflowService(
        prisma,
        clock,
        capability,
        verifier,
        batches,
        gate as never,
        raw as never,
      );
      const ready = await workflow.prepare(auth, session.id, {
        expectedRevision: session.revision,
      });
      expect(ready.state).toBe("READY");
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(
        initialExpenses,
      );
      expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(
        initialFlows,
      );
      const challenge = await workflow.challenge(
        auth,
        session.id,
        {
          expectedRevision: ready.revision,
          proposalHash: ready.proposal!.proposalHash,
        },
        {},
      );
      const financialRequestId = randomUUID();
      await workflow.confirm(
        auth,
        session.id,
        {
          expectedRevision: ready.revision,
          proposalHash: ready.proposal!.proposalHash,
          financialRequestId,
          nonce: challenge.nonce,
        },
        {},
      );
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(
        initialExpenses,
      );
      const guardedWorkflow = new ImportSessionWorkflowService(
        prisma,
        clock,
        capability,
        new RuntimeUiGrantVerifier(),
        batches,
        gate as never,
        raw as never,
      );
      await expect(
        guardedWorkflow.execute(auth, session.id, { financialRequestId }, {}),
      ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
      let failCleanup = true;
      prisma.$use(async (params, next) => {
        if (
          failCleanup &&
          params.model === "ImportObservation" &&
          params.action === "updateMany" &&
          params.args.data.evidenceJson === "{}"
        )
          throw new Error("retention cleanup failure");
        return next(params);
      });
      try {
        await expect(
          workflow.execute(auth, session.id, { financialRequestId }, {}),
        ).rejects.toThrow("retention cleanup failure");
      } finally {
        failCleanup = false;
      }
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(
        initialExpenses,
      );
      expect(
        (
          await prisma.importSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).state,
      ).toBe("CONFIRMED");
      expect(
        await prisma.importObservation.findMany({
          where: { artifactId: artifact.id },
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claimVersion: 0,
            evidenceJson: material.observations[0].evidenceJson,
            canonicalExpenseId: null,
          }),
          ...(deferred
            ? [
                expect.objectContaining({
                  evidenceJson: material.observations[1].evidenceJson,
                }),
              ]
            : []),
        ]),
      );
      const [receipt, concurrentReceipt] = await Promise.all([
        workflow.execute(auth, session.id, { financialRequestId }, {}),
        workflow.execute(auth, session.id, { financialRequestId }, {}),
      ]);
      expect(concurrentReceipt).toEqual(receipt);
      const applied = await prisma.importSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(applied).toMatchObject({
        state: "APPLIED",
        draftJson: EMPTY_DRAFT_JSON,
        searchJson: null,
        proposalJson: null,
        challengeJson: null,
      });
      expect(JSON.parse(applied.receiptJson!)).toEqual(receipt);
      // Invoice payments are terminal audit-only evidence, never continuation work.
      if (deferred) {
        expect(receipt.auditItems).toEqual([
          expect.objectContaining({
            outcome: "IGNORED",
            reason: "INVOICE_PAYMENT",
            amountCents: -100,
          }),
        ]);
      }
      expect(receipt.continuationSessionId).toBeNull();
      const claimed = await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        id: material.observations[0].id,
        artifactId: artifact.id,
        reference: material.observations[0].reference,
        evidenceJson: "{}",
        claimVersion: 1,
        canonicalProjectId: projectId,
        canonicalExpenseId: receipt.items[0].sourceExpenseId,
        canonicalIndex: 0,
        claimSessionId: session.id,
        claimedAt: current,
      });
      expect(JSON.parse(claimed[0].claimReceiptJson!)).toEqual({
        kind: "SESSION",
        sessionId: session.id,
        financialRequestId,
      });
      expect(
        (
          await prisma.importArtifact.findUniqueOrThrow({
            where: { id: artifact.id },
          })
        ).documentSha256,
      ).toBe(artifact.documentSha256);
      expect(await service.getObservations(auth, session.id)).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      expect(
        await prisma.importSessionArtifact.findUniqueOrThrow({
          where: { id: ref.id },
        }),
      ).toMatchObject({
        state: "RELEASED",
        fileName: "document",
        releasedAt: current,
      });
      const count = await prisma.expense.count({ where: { tenantId } });
      expect(count).toBe(initialExpenses + 1);
      expect(
        await workflow.execute(auth, session.id, { financialRequestId }, {}),
      ).toEqual(receipt);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(count);
      await expect(
        workflow.execute(
          auth,
          session.id,
          { financialRequestId: randomUUID() },
          {},
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect((await service.getResult(auth, session.id)).receipt).toEqual(
        receipt,
      );
      const upload = new ImportUploadService(
        prisma,
        clock,
        capability,
        verifier as never,
        gate as never,
      );
      await expect(
        upload.reserve(
          auth,
          session.id,
          {
            expectedRevision: applied.revision,
            files: [
              {
                id: randomUUID(),
                fileName: "later.csv",
                declaredBytes: 1,
                mime: "text/csv",
              },
            ],
          },
          {},
        ),
      ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
      const source = Readable.from([Buffer.from("x")]);
      await expect(
        upload.upload(auth, session.id, ref.id, 1, source, {}),
      ).rejects.toMatchObject({
        code: "LEASE_CONFLICT",
      });
      expect(source.readableDidRead).toBe(false);
      const otherTenant = await prisma.tenant.create({
        data: { name: "Other receipt tenant" },
      });
      const otherUser = await prisma.user.create({
        data: {
          tenantId: otherTenant.id,
          username: randomUUID(),
          name: "Other actor",
          role: "ADMIN",
        },
      });
      const otherAuth = mintImportAuthContext({
        tenantId: otherTenant.id,
        userId: otherUser.id,
        presentedSessionVersion: 0,
        tokenExpiresAt: new Date(current.getTime() + 3600000).toISOString(),
      });
      await expect(
        service.getResult(otherAuth, session.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await prisma.expense.count({ where: { tenantId: otherTenant.id } }),
      ).toBe(0);

      // Same-document reimport: the canonical row is skipped without parsing its
      // redacted evidence. Unclaimed ignored rows can be re-materialized from a
      // newly authorized extraction, without replacing the claim or its FKs.
      for (const terminal of ["CANCELLED", "EXPIRED"] as const) {
        const again = await create();
        const nextSession = await prisma.importSession.findUniqueOrThrow({
          where: { id: again.view.id },
        });
        const nextRef = await prisma.importSessionArtifact.create({
          data: {
            tenantId,
            ownerProjectId: projectId,
            sessionId: nextSession.id,
            artifactId: artifact.id,
            position: 0,
            fileName: "reimport.csv",
            declaredMime: "text/csv",
            declaredBytes: bytes.length,
            reservedBytes: 0,
            state: "ATTACHED",
            verifiedAt: current,
          },
        });
        const reimport = buildImportMaterialization({
          session: nextSession,
          attachment: nextRef,
          artifact,
          extraction,
          observations: claimed,
          draft: {
            ...JSON.parse(EMPTY_DRAFT_JSON),
            scope: { observationIds: [], pendingAttachmentIds: [nextRef.id] },
          },
          newIds: new Map(
            extraction.occurrences.map((occurrence) => [
              occurrence.reference,
              { observationId: randomUUID(), lineId: randomUUID() },
            ]),
          ),
        });
        expect(reimport.draft.lines).toEqual([]);
        expect(reimport.draft.scope.observationIds).not.toContain(
          claimed[0].id,
        );
        for (const observation of reimport.observations)
          await prisma.importObservation.create({ data: observation });
        await prisma.importSession.update({
          where: { id: nextSession.id },
          data: { draftJson: JSON.stringify(reimport.draft) },
        });
        expect(
          await prisma.$transaction((tx) =>
            importSessionWritesEnabled(tx, nextSession, capability),
          ),
        ).toBe(true);
        if (terminal === "CANCELLED") {
          await service.cancel(
            auth,
            nextSession.id,
            {
              expectedRevision: nextSession.revision,
            },
            {},
          );
        } else {
          current = nextSession.expiresAt;
          await new VaultReaper(
            prisma,
            clock,
            gate as never,
            raw as never,
          ).runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
        }
        expect(
          (
            await prisma.importSession.findUniqueOrThrow({
              where: { id: nextSession.id },
            })
          ).state,
        ).toBe(terminal);
        expect(
          await prisma.importObservation.findMany({
            where: { artifactId: artifact.id },
          }),
        ).toEqual(claimed);
        expect(await service.getObservations(auth, nextSession.id)).toEqual({
          items: [],
          nextCursor: null,
        });
        expect((await service.getResult(auth, session.id)).receipt).toEqual(
          receipt,
        );
        expect(
          await workflow.execute(auth, session.id, { financialRequestId }, {}),
        ).toEqual(receipt);
        expect(await prisma.expense.count({ where: { tenantId } })).toBe(count);
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      }
      // Historical APPLIED claim left after an earlier original purge: repair
      // evidence only, retaining every claim/FK and the authorized result/replay.
      await prisma.importObservation.update({
        where: { id: claimed[0].id },
        data: { evidenceJson: material.observations[0].evidenceJson },
      });
      await prisma.importArtifact.update({
        where: { id: artifact.id },
        data: { state: "PURGED", extractionJson: null },
      });
      await new VaultReaper(
        prisma,
        clock,
        gate as never,
        raw as never,
      ).runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
      expect(
        await prisma.importObservation.findMany({
          where: { artifactId: artifact.id },
        }),
      ).toEqual(claimed);
      expect((await service.getResult(auth, session.id)).receipt).toEqual(
        receipt,
      );
      expect(
        await workflow.execute(auth, session.id, { financialRequestId }, {}),
      ).toEqual(receipt);
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);

      // QA f2d4c90: an APPLIED result is immutable even after its real canonical
      // row is soft-deleted. Replay must not create finance, activity or flows.
      const sourceId = receipt.items[0].sourceExpenseId;
      const sourceBefore = await prisma.expense.findUniqueOrThrow({
        where: { id: sourceId },
      });
      const appliedBefore = await prisma.importSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      const activitiesBefore = await prisma.userActivityLog.findMany({
        where: { tenantId },
        orderBy: { id: "asc" },
      });
      expect(activitiesBefore).toHaveLength(initialActivities + 1);
      expect(activitiesBefore).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenantId,
            userId,
            action: "importSessions.execute",
            createdAt: claimed[0].claimedAt,
          }),
        ]),
      );
      const flowsBefore = await prisma.cashFlowEntry.findMany({
        where: { expenseId: sourceId },
        orderBy: { id: "asc" },
      });
      await prisma.$transaction(async (tx) => {
        await tx.expense.delete({ where: { id: sourceId } });
      });
      const sourceAfter = await prisma.expense.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect(sourceAfter.deletedAt).toBeInstanceOf(Date);
      expect(sourceAfter).toEqual({
        ...sourceBefore,
        deletedAt: sourceAfter.deletedAt,
        updatedAt: sourceAfter.updatedAt,
      });
      expect(
        await prisma.importObservation.findUnique({
          where: { id: claimed[0].id },
        }),
      ).toBeNull();
      expect(
        await prisma.importSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toEqual(appliedBefore);
      expect((await service.getResult(auth, session.id)).receipt).toEqual(
        receipt,
      );
      expect(
        await workflow.execute(auth, session.id, { financialRequestId }, {}),
      ).toEqual(receipt);
      expect(
        await prisma.expense.count({
          where: { tenantId, deletedAt: { not: undefined } },
        }),
      ).toBe(count);
      expect(
        await prisma.userActivityLog.findMany({
          where: { tenantId },
          orderBy: { id: "asc" },
        }),
      ).toEqual(activitiesBefore);
      expect(
        await prisma.cashFlowEntry.findMany({
          where: { expenseId: sourceId },
          orderBy: { id: "asc" },
        }),
      ).toEqual(flowsBefore);
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    },
  );

  it("canonical deletion invalidates a referencing READY draft and nonce, without extending expiry or editing a separate draft", async () => {
    const created = await create();
    const separate = await create();
    const { session, material } = await attachCsv(
      created.view.id,
      Buffer.from(
        "date,title,amount\n2026-10-01,Pending linkage PARC 1/2,1.00\n",
      ),
    );
    const draft = {
      ...material.draft,
      questions: [],
      selectedLineIds: material.draft.lines.map((line) => line.id),
      lines: material.draft.lines.map((line) => ({
        ...line,
        amountMeaning: "TOTAL_PURCHASE" as const,
        amountCents: 200,
        installmentCount: 2,
        firstDueDate: "2026-10-10",
        targets: [],
        tipoDespesa: ExpenseType.OUTROS,
        decision: { kind: "CREATE" as const, acceptNaturalDuplicate: false },
      })),
    };
    await prisma.importSession.update({
      where: { id: session.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    const conciliacao = new ConciliacaoService(prisma);
    const expenses = new ExpenseService(prisma, conciliacao);
    // Test stale revision/nonce independently of the scoped CSV capability gate.
    // The default gate correctly closes once the artifact has retired.
    const qualified = {
      writesEnabled: () => true,
      newImportFormats: capability.newImportFormats.bind(capability),
    };
    const workflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      qualified,
      verifier,
      new CardPurchaseBatchAdapter(expenses, conciliacao, clock),
      gate as never,
      raw as never,
    );
    const ready = await workflow.prepare(auth, session.id, {
      expectedRevision: session.revision,
    });
    expect(ready.state).toBe("READY");
    const challenge = await workflow.challenge(
      auth,
      session.id,
      {
        expectedRevision: ready.revision,
        proposalHash: ready.proposal!.proposalHash,
      },
      {},
    );
    const row = await expenses.create(tenantId, projectId, {
      tipoDespesa: ExpenseType.OUTROS,
      valor: 1,
      quantidade: 1,
      formaPagamento: PaymentForm.A_VISTA,
      dataPagamento: "2026-10-10T12:00:00.000Z",
      status: "PLANEJADO",
    });
    await prisma.importObservation.update({
      where: { id: material.observations[0].id },
      data: {
        claimVersion: 1,
        canonicalProjectId: projectId,
        canonicalExpenseId: row.id,
        canonicalIndex: 0,
        claimReceiptJson: '{"kind":"SESSION","fixture":"concurrent-claim"}',
        claimedAt: current,
      },
    });
    const before = await prisma.importSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    const separateBefore = await prisma.importSession.findUniqueOrThrow({
      where: { id: separate.view.id },
    });
    await prisma.expense.delete({ where: { id: row.id } });
    const after = await prisma.importSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.state).toBe("REVIEW_REQUIRED");
    expect(after.revision).toBe(before.revision + 1);
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.lastUserEditAt).toEqual(before.lastUserEditAt);
    expect(after.proposalJson).toBeNull();
    expect(after.challengeJson).toBeNull();
    const stale = await service.getSession(auth, session.id);
    expect(stale.actions).not.toContain("ANALYZE");
    expect(stale.attachments).toEqual([
      expect.objectContaining({
        state: "ATTACHED",
        materializedInSession: false,
        canAnalyze: false,
      }),
    ]);
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: separate.view.id },
      }),
    ).toEqual(separateBefore);
    await expect(
      workflow.prepare(auth, session.id, { expectedRevision: ready.revision }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      workflow.confirm(
        auth,
        session.id,
        {
          expectedRevision: ready.revision,
          proposalHash: ready.proposal!.proposalHash,
          financialRequestId: randomUUID(),
          nonce: challenge.nonce,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const defaultWorkflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      verifier,
      new CardPurchaseBatchAdapter(expenses, conciliacao, clock),
      gate as never,
      raw as never,
    );
    await expect(
      defaultWorkflow.prepare(auth, session.id, {
        expectedRevision: after.revision,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    expect(
      await prisma.importObservation.findUnique({
        where: { id: material.observations[0].id },
      }),
    ).toBeNull();
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });
});
