import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  ProjectType,
  ExpenseType,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../expense/expense.service";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { DefaultImportSessionCapability } from "./import-session.capability";
import { mintImportAuthContext } from "./import-session.auth";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { ImportSessionExtractionService } from "./import-session.extraction.service";
import { ImportRawExecutions } from "./import-session.raw-executions";
import { ImportUploadService } from "./vault/import-upload.service";
import { VaultFdRegistry } from "./vault/vault-fd-registry";
import { VaultStorage } from "./vault/vault-storage";
import { PurgeCoordinator } from "./vault/vault-purger";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import type { VaultBootHandle, VaultRuntime } from "./vault/vault-boot";

function invoice(blank = false, pages = 1, marker = ""): Buffer {
  const lines = blank
    ? []
    : [
        "Fatura",
        "01/02/2026 STORE PARC 1/2 10,01",
        "01/02/2026 STORE PARC 1/2 10,01",
        "02/02/2026 PAGAMENTO DE FATURA -20,02",
      ];
  const body = (pages > 1 ? lines.slice(0, 2) : lines)
    .map((line, i) => `BT /F1 12 Tf 50 ${750 - i * 20} Td (${line}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pages - 1 }, (_, i) => `${6 + i} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    ...Array.from(
      { length: pages - 1 },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    ),
  ];
  let value = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("");
  return Buffer.from(
    `${value}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n%${marker}\n`,
  );
}

describe("private PDF import native pipeline", () => {
  const prisma = new PrismaService();
  const now = new Date("2026-10-10T12:00:00.000Z");
  const clock = { now: (): Date => now };
  const capability = new DefaultImportSessionCapability();
  const verifier = { verify: jest.fn(), verifyFinancialAction: jest.fn() };
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("upload/analyze/selected confirm uses native writer and replays receipt without prefinancial effects", async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    await prisma.$connect();
    const tenantId = (
      await prisma.tenant.create({ data: { name: "PDF fixture" } })
    ).id;
    const userId = (
      await prisma.user.create({
        data: {
          tenantId,
          username: randomUUID(),
          name: "PDF fixture",
          role: "ADMIN",
        },
      })
    ).id;
    const projectId = (
      await prisma.project.create({
        data: {
          tenantId,
          name: "PDF fixture",
          type: ProjectType.PESSOAL,
        },
      })
    ).id;
    const cardId = (
      await prisma.creditCard.create({
        data: {
          tenantId,
          projectId,
          nickname: "PDF",
          institution: "fixture",
          last4: "1234",
          closingDay: 5,
          dueDay: 10,
        },
      })
    ).id;
    const auth = mintImportAuthContext({
      tenantId,
      userId,
      presentedSessionVersion: 0,
      tokenExpiresAt: "2026-10-11T12:00:00.000Z",
    });
    const root = mkdtempSync(join(tmpdir(), "pdf-import-"));
    mkdirSync(join(root, "t"), { mode: 0o700 });
    mkdirSync(join(root, "trash"), { mode: 0o700 });
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
    const registry = new VaultFdRegistry();
    const storage = new VaultStorage(boot, registry, clock);
    const purger = new PurgeCoordinator(
      prisma,
      clock,
      boot,
      registry,
      storage,
      1000,
    );
    const gate = {
      boot,
      registry,
      storage,
      requirePurger: () => purger,
    } as never;
    const raw = new ImportRawExecutions(gate, clock, capability);
    const sessions = new ImportSessionService(
      prisma,
      clock,
      capability,
      verifier,
      gate,
      raw,
    );
    const uploads = new ImportUploadService(
      prisma,
      clock,
      capability,
      verifier,
      gate,
    );
    const extraction = new ImportSessionExtractionService(
      prisma,
      clock,
      capability,
      verifier,
      gate,
      raw,
    );
    const conciliacao = new ConciliacaoService(prisma);
    const workflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      verifier,
      new CardPurchaseBatchAdapter(
        new ExpenseService(prisma, conciliacao),
        conciliacao,
        clock,
      ),
      gate,
      raw,
    );
    const financialCounts = async () =>
      Promise.all([
        prisma.expense.count({ where: { tenantId } }),
        prisma.cashFlowEntry.count({ where: { tenantId } }),
        prisma.receipt.count({ where: { tenantId } }),
        prisma.rateioAllocation.count({ where: { tenantId } }),
        prisma.crossProjectSettlement.count({ where: { tenantId } }),
        prisma.importedInvoiceLiquidation.count({ where: { tenantId } }),
      ]);
    try {
      const created = await sessions.create(
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
      const bytes = invoice();
      const attachmentId = randomUUID();
      await expect(
        uploads.reserve(
          auth,
          created.view.id,
          {
            expectedRevision: created.view.revision,
            files: [
              {
                id: attachmentId,
                fileName: "invoice.pdf",
                declaredBytes: bytes.length,
                mime: "text/csv",
              },
            ],
          },
          {},
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_DOCUMENT" });
      const reserved = await uploads.reserve(
        auth,
        created.view.id,
        {
          expectedRevision: created.view.revision,
          files: [
            {
              id: attachmentId,
              fileName: "invoice.pdf",
              declaredBytes: bytes.length,
              mime: "application/pdf",
            },
          ],
        },
        {},
      );
      const uploaded = await uploads.upload(
        auth,
        reserved.id,
        attachmentId,
        bytes.length,
        Readable.from([bytes]),
        {},
      );
      const analyzed = await extraction.analyzeAttached(
        auth,
        uploaded.id,
        attachmentId,
        { expectedRevision: uploaded.revision },
        {},
      );
      expect(analyzed.lines).toHaveLength(2);
      expect(await financialCounts()).toEqual([0, 0, 0, 0, 0, 0]);
      const privateState = await prisma.importSession.findUniqueOrThrow({
        where: { id: analyzed.id },
      });
      const privateRef = await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: attachmentId },
      });
      const privateArtifact = await prisma.importArtifact.findUniqueOrThrow({
        where: { id: privateRef.artifactId! },
      });
      const otherTenantId = (
        await prisma.tenant.create({ data: { name: "PDF outsider" } })
      ).id;
      const otherUserId = (
        await prisma.user.create({
          data: {
            tenantId: otherTenantId,
            username: randomUUID(),
            name: "outsider",
            role: "ADMIN",
          },
        })
      ).id;
      const otherAuth = mintImportAuthContext({
        tenantId: otherTenantId,
        userId: otherUserId,
        presentedSessionVersion: 0,
        tokenExpiresAt: "2026-10-11T12:00:00.000Z",
      });
      await expect(
        sessions.getSession(otherAuth, analyzed.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        sessions.getObservations(otherAuth, analyzed.id, {}),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        uploads.upload(
          otherAuth,
          analyzed.id,
          attachmentId,
          bytes.length,
          Readable.from([bytes]),
          {},
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        extraction.analyzeAttached(
          otherAuth,
          analyzed.id,
          attachmentId,
          { expectedRevision: analyzed.revision },
          {},
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await prisma.importSession.findUniqueOrThrow({
          where: { id: analyzed.id },
        }),
      ).toEqual(privateState);
      expect(
        await prisma.importArtifact.findUniqueOrThrow({
          where: { id: privateArtifact.id },
        }),
      ).toEqual(privateArtifact);
      await expect(
        uploads.reserve(
          otherAuth,
          analyzed.id,
          {
            expectedRevision: analyzed.revision,
            files: [
              {
                id: randomUUID(),
                fileName: "invoice.pdf",
                declaredBytes: bytes.length,
                mime: "application/pdf",
              },
            ],
          },
          {},
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
      expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
      const observations = await sessions.getObservations(
        auth,
        analyzed.id,
        {},
      );
      expect(observations.items).toHaveLength(3);
      expect(observations.nextCursor).toBeNull();
      const payment = observations.items.filter(
        (row) => row.ignoredReason === "INVOICE_PAYMENT",
      );
      expect(payment).toHaveLength(1);
      expect(payment[0]).toMatchObject({
        attachmentId,
        amountCents: -2002,
        dataCompra: "2026-02-02",
        ignoredReason: "INVOICE_PAYMENT",
      });
      expect(
        analyzed.lines.flatMap((line) => line.observationIds),
      ).not.toContain(payment[0].id);
      const selectionRequest = {
        expectedRevision: analyzed.revision,
        questionId: null,
        selectedLineIds: [analyzed.lines[0].id],
        replaceLines: [],
      };
      await expect(
        workflow.edit(otherAuth, analyzed.id, selectionRequest),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const stored = await prisma.importSession.findUniqueOrThrow({
        where: { id: analyzed.id },
      });
      const fixtureDraft = JSON.parse(stored.draftJson);
      fixtureDraft.lines = fixtureDraft.lines.map((line: { id: string }) => ({
        ...line,
        firstDueDate: "2026-10-10",
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 2002,
        installmentCount: 2,
        tipoDespesa: ExpenseType.OUTROS,
        targets: [],
        decision: { kind: "CREATE", acceptNaturalDuplicate: false },
      }));
      fixtureDraft.selectedLineIds = [analyzed.lines[0].id];
      await prisma.importSession.update({
        where: { id: analyzed.id },
        data: { draftJson: JSON.stringify(fixtureDraft) },
      });
      const edited = await workflow.edit(auth, analyzed.id, selectionRequest);
      const ready = await workflow.prepare(auth, edited.id, {
        expectedRevision: edited.revision,
      });
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
      expect(ready.state).toBe("READY");
      expect(await financialCounts()).toEqual([0, 0, 0, 0, 0, 0]);
      const proposalHash = ready.proposal!.proposalHash;
      await expect(
        workflow.challenge(
          otherAuth,
          ready.id,
          { expectedRevision: ready.revision, proposalHash },
          {},
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const challenge = await workflow.challenge(
        auth,
        ready.id,
        { expectedRevision: ready.revision, proposalHash },
        {},
      );
      const financialRequestId = randomUUID();
      await expect(
        workflow.confirm(
          otherAuth,
          ready.id,
          {
            expectedRevision: ready.revision,
            proposalHash,
            financialRequestId,
            nonce: challenge.nonce,
          },
          {},
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await workflow.confirm(
        auth,
        ready.id,
        {
          expectedRevision: ready.revision,
          proposalHash,
          financialRequestId,
          nonce: challenge.nonce,
        },
        {},
      );
      expect(await financialCounts()).toEqual([0, 0, 0, 0, 0, 0]);
      await expect(
        workflow.execute(otherAuth, ready.id, { financialRequestId }, {}),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const applied = await workflow.execute(
        auth,
        ready.id,
        { financialRequestId },
        {},
      );
      const replay = await workflow.execute(
        auth,
        ready.id,
        { financialRequestId },
        {},
      );
      expect(replay).toEqual(applied);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(1);
      expect(await financialCounts()).toEqual([1, 2, 0, 0, 0, 0]);
      const expense = await prisma.expense.findFirstOrThrow({
        where: { tenantId },
      });
      expect(expense).toMatchObject({
        projectId,
        valor: 2002,
        valorTotal: 2002,
        quantidade: 1,
        quantidadeParcela: 2,
        status: "PLANEJADO",
        settledByExpenseId: null,
        linkedExpenseId: null,
      });
      const flows = await prisma.cashFlowEntry.findMany({
        where: { tenantId },
        orderBy: { data: "asc" },
      });
      expect(
        flows.map((flow) => ({
          expenseId: flow.expenseId,
          valor: flow.valor,
          data: flow.data.toISOString().slice(0, 10),
          parcela: flow.parcela,
          status: flow.status,
          tipo: flow.tipo,
        })),
      ).toEqual([
        {
          expenseId: expense.id,
          valor: 1001,
          data: "2026-10-10",
          parcela: "1/2",
          status: "PLANEJADO",
          tipo: "DESPESA",
        },
        {
          expenseId: expense.id,
          valor: 1001,
          data: "2026-11-10",
          parcela: "2/2",
          status: "PLANEJADO",
          tipo: "DESPESA",
        },
      ]);
      const retainedPayment = await prisma.importObservation.findUniqueOrThrow({
        where: { id: payment[0].id },
      });
      expect(retainedPayment).toMatchObject({
        canonicalExpenseId: null,
        canonicalReceiptId: null,
        canonicalProjectId: null,
        claimSessionId: null,
        claimedAt: null,
      });
      expect(
        parseStoredImportObservationEvidence(retainedPayment.evidenceJson),
      ).toMatchObject({
        sourceDescription: "PAGAMENTO DE FATURA",
        amountCents: -2002,
      });
      const unselected = await prisma.importObservation.findMany({
        where: { id: { in: analyzed.lines[1].observationIds } },
      });
      expect(unselected).toHaveLength(1);
      expect(unselected[0]).toMatchObject({
        canonicalExpenseId: null,
        canonicalReceiptId: null,
        claimSessionId: null,
        claimedAt: null,
      });
      const bounded = await sessions.create(
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
      const pageFiles = Array.from({ length: 3 }, (_, i) => ({
        id: randomUUID(),
        bytes: invoice(false, 30, String(i)),
      }));
      let boundedView = await uploads.reserve(
        auth,
        bounded.view.id,
        {
          expectedRevision: bounded.view.revision,
          files: pageFiles.map((file) => ({
            id: file.id,
            fileName: "pages.pdf",
            declaredBytes: file.bytes.length,
            mime: "application/pdf",
          })),
        },
        {},
      );
      for (const file of pageFiles)
        boundedView = await uploads.upload(
          auth,
          bounded.view.id,
          file.id,
          file.bytes.length,
          Readable.from([file.bytes]),
          {},
        );
      boundedView = await extraction.analyzeAttached(
        auth,
        bounded.view.id,
        pageFiles[0].id,
        { expectedRevision: boundedView.revision },
        {},
      );
      const races = await Promise.allSettled(
        pageFiles
          .slice(1)
          .map((file) =>
            extraction.analyzeAttached(
              auth,
              bounded.view.id,
              file.id,
              { expectedRevision: boundedView.revision },
              {},
            ),
          ),
      );
      expect(
        races.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = races.findIndex(
        (result) => result.status === "rejected",
      );
      // Either admission loses the session lease, or publication observes the
      // winner's revision. Neither is a parser error or a partial publication.
      const loser = races[rejected];
      expect(loser.status).toBe("rejected");
      if (loser.status !== "rejected") throw new Error("Missing rejected race");
      expect(["LEASE_CONFLICT", "REVISION_CONFLICT"]).toContain(
        loser.reason.code,
      );
      boundedView = await sessions.getSession(auth, bounded.view.id);
      await expect(
        extraction.analyzeAttached(
          auth,
          bounded.view.id,
          pageFiles[rejected + 1].id,
          { expectedRevision: boundedView.revision },
          {},
        ),
      ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
      const boundedRefs = await prisma.importSessionArtifact.findMany({
        where: { sessionId: bounded.view.id },
        include: { artifact: true },
      });
      expect(
        boundedRefs.filter((ref) => ref.artifact?.state === "EXTRACTED"),
      ).toHaveLength(2);
      expect(
        boundedRefs.filter((ref) => ref.artifact?.extractionJson === null),
      ).toHaveLength(1);
      const extractedArtifacts = boundedRefs
        .filter((ref) => ref.artifact?.state === "EXTRACTED")
        .map((ref) => ref.artifact!);
      expect(
        extractedArtifacts.map(
          (artifact) => JSON.parse(artifact.extractionJson!).metrics.pages,
        ),
      ).toEqual([30, 30]);
      expect(
        extractedArtifacts.reduce(
          (sum, artifact) =>
            sum + JSON.parse(artifact.extractionJson!).metrics.pages,
          0,
        ),
      ).toBe(60);
      const boundedObservations = await prisma.importObservation.findMany({
        where: {
          artifactId: { in: boundedRefs.map((ref) => ref.artifactId!) },
        },
      });
      expect(boundedObservations).toHaveLength(60);
      const unpublished = boundedRefs.find(
        (ref) => ref.artifact?.extractionJson === null,
      )!.artifact!;
      expect(unpublished).toMatchObject({
        state: "RAW_READY",
        leaseSessionId: null,
        extractionJson: null,
        parserVersion: null,
      });
      expect(
        boundedObservations.filter((row) => row.artifactId === unpublished.id),
      ).toEqual([]);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(1);
      expect(await financialCounts()).toEqual([1, 2, 0, 0, 0, 0]);
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      expect(applied.items).toHaveLength(1);
      expect(applied.snapshot.createdEconomicTotalCents).toBe(2002);
      const failed = await sessions.create(
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
      const scan = invoice(true);
      const failedAttachment = randomUUID();
      const failedReserved = await uploads.reserve(
        auth,
        failed.view.id,
        {
          expectedRevision: failed.view.revision,
          files: [
            {
              id: failedAttachment,
              fileName: "scan.pdf",
              declaredBytes: scan.length,
              mime: "application/pdf",
            },
          ],
        },
        {},
      );
      const failedUploaded = await uploads.upload(
        auth,
        failedReserved.id,
        failedAttachment,
        scan.length,
        Readable.from([scan]),
        {},
      );
      await expect(
        extraction.analyzeAttached(
          auth,
          failedUploaded.id,
          failedAttachment,
          { expectedRevision: failedUploaded.revision },
          {},
        ),
      ).rejects.toMatchObject({ code: "OCR_REQUIRED" });
      const failedRef = await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: failedAttachment },
      });
      const failedArtifact = await prisma.importArtifact.findUniqueOrThrow({
        where: { id: failedRef.artifactId! },
      });
      expect(failedArtifact).toMatchObject({
        state: "RAW_READY",
        extractionJson: null,
        leaseSessionId: null,
      });
      expect(failedArtifact.parseGeneration).toBe(1);
      expect(
        await prisma.importObservation.count({
          where: { artifactId: failedArtifact.id },
        }),
      ).toBe(0);
      expect(
        (await sessions.getSession(auth, failedUploaded.id)).lines,
      ).toEqual([]);
      const controller = new AbortController();
      controller.abort();
      await expect(
        extraction.analyzeAttached(
          auth,
          failedUploaded.id,
          failedAttachment,
          { expectedRevision: failedUploaded.revision },
          {},
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
      await sessions.cancel(
        auth,
        failedUploaded.id,
        { expectedRevision: failedUploaded.revision },
        {},
      );
      await expect(
        extraction.analyzeAttached(
          auth,
          failedUploaded.id,
          failedAttachment,
          { expectedRevision: failedUploaded.revision },
          {},
        ),
      ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
      expect(
        await prisma.importObservation.count({
          where: { artifactId: failedArtifact.id },
        }),
      ).toBe(0);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(1);
      expect(await financialCounts()).toEqual([1, 2, 0, 0, 0, 0]);
      expect(
        await prisma.cashFlowEntry.findMany({
          where: { tenantId },
          orderBy: { data: "asc" },
        }),
      ).toEqual(flows);
      expect(
        await prisma.expense.count({ where: { tenantId: otherTenantId } }),
      ).toBe(0);
      expect(
        await prisma.cashFlowEntry.count({
          where: { tenantId: otherTenantId },
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
