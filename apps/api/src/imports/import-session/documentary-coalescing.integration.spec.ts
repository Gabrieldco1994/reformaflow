import type { ExecutionContext } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  ExpenseType,
  ProjectType,
  encodeImportDeclaration,
  isPendingImportQuestion,
  type ImportDeclarationContextV1,
  type ImportHumanFactFieldV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../expense/expense.service";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { DefaultImportSessionCapability } from "./import-session.capability";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { ImportSessionExtractionService } from "./import-session.extraction.service";
import { ImportRawExecutions } from "./import-session.raw-executions";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { ImportUiGuard } from "./import-session-ui.guard";
import { documentaryAnswerScope } from "./import-session.native-answer";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { ImportSessionController } from "./import-session.controller";
import type { UiImportGrantScope } from "./import-session.contract";
import { ImportUploadService } from "./vault/import-upload.service";
import { VaultFdRegistry } from "./vault/vault-fd-registry";
import { VaultStorage } from "./vault/vault-storage";
import { PurgeCoordinator } from "./vault/vault-purger";
import type { VaultBootHandle, VaultRuntime } from "./vault/vault-boot";

/** Synthetic textual bytes only; no parser result, original identity or draft is seeded. */
function invoice(documentedYear = false): Buffer {
  const text = documentedYear
    ? [
        "Fatura",
        "01/09/2025 LOJA FICTICIA NORTE 1.234,56",
        "01/09/2025 LOJA FICTICIA NORTE 1.234,56",
        "02/09/2025 PAGAMENTO DE FATURA -2.469,12",
      ]
    : [
        "Fatura",
        "01/09 LOJA FICTICIA NORTE 1.234,56",
        "02/09 PAGAMENTO DE FATURA -1.234,56",
      ];
  const body = text
    .map((line, i) => `BT /F1 12 Tf 50 ${750 - i * 20} Td (${line}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
  ];
  let value = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("");
  return Buffer.from(
    `${value}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

describe("real upload → materialization → native documentary coalescing → preparation", () => {
  const prisma = new PrismaService();
  const now = new Date("2026-10-10T12:00:00.000Z");
  const clock = { now: (): Date => now };
  const capability = new DefaultImportSessionCapability();
  const verifier = new RuntimeUiGrantVerifier();
  const issuer = new ImportUiGrantIssuer(clock);
  const ui = new ImportUiGuard(
    { allowed: () => ["http://localhost:3000"] },
    issuer,
  );
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(["PDF", "CSV", "PDF_DOCUMENTED_YEAR"] as const)(
    "%s: native facts retire duplicate tasks without gaining financial authority",
    async (format) => {
      expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
      await prisma.$connect();
      const documentedYear = format === "PDF_DOCUMENTED_YEAR";
      const documentFormat = documentedYear ? "PDF" : format;
      const tenantId = (
        await prisma.tenant.create({ data: { name: "native coalescing" } })
      ).id;
      const userId = (
        await prisma.user.create({
          data: {
            tenantId,
            username: randomUUID(),
            name: "fixture",
            role: "ADMIN",
          },
        })
      ).id;
      const projectId = (
        await prisma.project.create({
          data: { tenantId, name: "fixture", type: ProjectType.PESSOAL },
        })
      ).id;
      const cardId = (
        await prisma.creditCard.create({
          data: {
            tenantId,
            projectId,
            nickname: "fixture",
            institution: "fixture",
            last4: "1234",
            closingDay: 5,
            dueDay: 10,
          },
        })
      ).id;
      const request = {
        headers: { origin: "http://localhost:3000", "x-rf-import-ui": "1" },
        user: {
          id: userId,
          tenantId,
          authClaims: {
            sessionVersion: 0,
            expiresAtEpochSeconds: now.getTime() / 1000 + 86400,
          },
        },
      };
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as ExecutionContext;
      new ImportAuthGuard().canActivate(context);
      ui.canActivate(context);
      const auth = readImportAuthForRequest(request);
      const grant = (scope: UiImportGrantScope) =>
        issuer.issue(request, auth, scope);
      const root = mkdtempSync(join(tmpdir(), "documentary-coalescing-"));
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
      const controller = new ImportSessionController(
        sessions,
        issuer,
        capability,
        workflow,
      );
      const counts = async (): Promise<number[]> =>
        Promise.all([
          prisma.expense.count({ where: { tenantId } }),
          prisma.cashFlowEntry.count({ where: { tenantId } }),
          prisma.receipt.count({ where: { tenantId } }),
          prisma.rateioAllocation.count({ where: { tenantId } }),
          prisma.crossProjectSettlement.count({ where: { tenantId } }),
          prisma.importedInvoiceLiquidation.count({ where: { tenantId } }),
        ]);
      let view: ImportSessionViewV1;
      const answer = async (
        field: ImportHumanFactFieldV1,
        text: string,
      ): Promise<void> => {
        const question = view.questions.find(
          (q) =>
            q.field === field && "subject" in q && isPendingImportQuestion(q),
        );
        expect(question).toBeDefined();
        if (!question || !("subject" in question))
          throw Error("Missing native subject");
        const input = { kind: "VALUE" as const, text };
        const encoded = encodeImportDeclaration(
          {
            field,
            meaningContext: question.subject.meaningContext,
            effectiveInstallmentCount: null,
          } as ImportDeclarationContextV1,
          input,
        );
        if (encoded.kind !== "ENCODED") throw Error("Invalid fixture preview");
        const payload = {
          version: 1 as const,
          answerRequestId: randomUUID(),
          expectedRevision: view.revision,
          questionId: question.id,
          input,
          answer: encoded.answer,
        };
        view = await workflow.documentaryAnswer(
          auth,
          view.id,
          payload,
          grant(documentaryAnswerScope(view.id, payload)),
        );
      };
      try {
        const createRequestId = randomUUID();
        view = (
          await sessions.create(
            auth,
            {
              version: 1,
              createRequestId,
              cardId,
              consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
              consentAnalyze: true,
            },
            grant({
              operation: "CREATE_SESSION",
              cardId,
              createRequestId,
              consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
            }),
          )
        ).view;
        const bytes =
          documentFormat === "PDF"
            ? invoice(documentedYear)
            : Buffer.from(
                "date,title,amount\n2025-09-01,LOJA FICTICIA NORTE,1234.56\n2025-09-02,PAGAMENTO DE FATURA,-1234.56\n",
              );
        const attachmentId = randomUUID();
        view = await uploads.reserve(
          auth,
          view.id,
          {
            expectedRevision: view.revision,
            files: [
              {
                id: attachmentId,
                fileName: `invoice.${documentFormat.toLowerCase()}`,
                declaredBytes: bytes.length,
                mime: documentFormat === "PDF" ? "application/pdf" : "text/csv",
              },
            ],
          },
          grant({
            operation: "RESERVE_ATTACHMENTS",
            sessionId: view.id,
            expectedRevision: view.revision,
          }),
        );
        view = await uploads.upload(
          auth,
          view.id,
          attachmentId,
          bytes.length,
          Readable.from([bytes]),
          grant({
            operation: "UPLOAD_CONTENT",
            sessionId: view.id,
            attachmentId,
            uploadGeneration: 1,
          }),
        );
        view = await extraction.analyzeAttached(
          auth,
          view.id,
          attachmentId,
          { expectedRevision: view.revision },
          grant({
            operation: "ANALYZE_ATTACHMENT",
            sessionId: view.id,
            attachmentId,
            expectedRevision: view.revision,
          }),
        );
        if (documentedYear) {
          expect(view.lines).toHaveLength(2);
          const originals = await prisma.importObservation.findMany({
            where: { tenantId },
            orderBy: { reference: "asc" },
          });
          expect(originals).toHaveLength(3);
          const evidence = originals.map((row) =>
            parseStoredImportObservationEvidence(row.evidenceJson),
          );
          expect(
            evidence.map((row) => ({
              date: row.dataCompra,
              cents: row.amountCents,
              ordinal: row.identity.ordinal,
            })),
          ).toEqual([
            { date: "2025-09-01", cents: 123456, ordinal: 0 },
            { date: "2025-09-01", cents: 123456, ordinal: 1 },
            { date: "2025-09-02", cents: -246912, ordinal: 0 },
          ]);
          expect(
            view.questions.filter(
              (q) => q.field === "dataCompra" && isPendingImportQuestion(q),
            ),
          ).toEqual([]);
          for (let i = 0; i < 2; i++)
            await answer("amountMeaning", "total da compra");
          for (let i = 0; i < 2; i++) await answer("installmentCount", "1");
          for (let i = 0; i < 2; i++) await answer("installmentIndex", "1");
          expect(
            view.lines.map((line) => ({
              date: line.dataCompra,
              cents: line.amountCents,
              meaning: line.amountMeaning,
              decision: line.decision.kind,
            })),
          ).toEqual([
            {
              date: "2025-09-01",
              cents: 123456,
              meaning: "TOTAL_PURCHASE",
              decision: "UNRESOLVED",
            },
            {
              date: "2025-09-01",
              cents: 123456,
              meaning: "TOTAL_PURCHASE",
              decision: "UNRESOLVED",
            },
          ]);
          const immutable = async () =>
            (
              await prisma.importObservation.findMany({
                where: { tenantId },
                orderBy: { reference: "asc" },
              })
            ).map((row) => ({
              id: row.id,
              reference: row.reference,
              evidenceJson: row.evidenceJson,
            }));
          const originalEvidence = originals.map((row) => ({
            id: row.id,
            reference: row.reference,
            evidenceJson: row.evidenceJson,
          }));
          expect(await immutable()).toEqual(originalEvidence);
          expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
          const paymentPage = await sessions.getObservations(auth, view.id);
          const payment = paymentPage.items.filter(
            (o) => o.ignoredReason === "INVOICE_PAYMENT",
          );
          expect(payment).toHaveLength(1);
          expect(payment[0].amountCents).toBe(-246912);
          expect(
            view.lines.flatMap((line) => line.observationIds),
          ).not.toContain(payment[0].id);
          // Dedicated native draft action, never conversational/model permission.
          view = await controller.edit(auth, view.id, {
            expectedRevision: view.revision,
            questionId: null,
            selectedLineIds: view.lines.map((line) => line.id),
            replaceLines: view.lines.map((line) => ({
              ...line,
              firstDueDate: "2026-10-10",
              tipoDespesa: ExpenseType.OUTROS,
              targets: [],
              decision: { kind: "CREATE", acceptNaturalDuplicate: false },
            })),
          });
          view = await controller.prepare(auth, view.id, {
            expectedRevision: view.revision,
          });
          expect(view.state).toBe("READY");
          expect(
            view.reviewBlockers.some(
              (b) => b.resolution === "SEARCH_IDENTITY_UNAVAILABLE",
            ),
          ).toBe(false);
          expect(await immutable()).toEqual(originalEvidence);
          expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
          const ready = view;
          const proposalHash = ready.proposal!.proposalHash;
          const financialRequest = () => {
            const fresh = {
              headers: { ...request.headers },
              user: { ...request.user },
            };
            const freshContext = {
              switchToHttp: () => ({ getRequest: () => fresh }),
            } as ExecutionContext;
            new ImportAuthGuard().canActivate(freshContext);
            ui.canActivate(freshContext);
            return { request: fresh, auth: readImportAuthForRequest(fresh) };
          };
          const challengeRequest = financialRequest();
          const challenge = await controller.challenge(
            challengeRequest.request as never,
            challengeRequest.auth,
            ready.id,
            {
              expectedRevision: ready.revision,
              proposalHash,
            },
          );
          const confirmation = {
            expectedRevision: ready.revision,
            proposalHash,
            financialRequestId: randomUUID(),
            nonce: challenge.nonce,
          };
          const confirmRequest = financialRequest();
          await controller.confirm(
            confirmRequest.request as never,
            confirmRequest.auth,
            ready.id,
            confirmation,
          );
          expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
          const execute = () => {
            const executeRequest = financialRequest();
            return controller.execute(
              executeRequest.request as never,
              executeRequest.auth,
              ready.id,
              {
                financialRequestId: confirmation.financialRequestId,
              },
            );
          };
          const receipt = await execute();
          expect(receipt.items).toHaveLength(2);
          expect(receipt.snapshot.createdEconomicTotalCents).toBe(246912);
          const confirmReplayRequest = financialRequest();
          await controller.confirm(
            confirmReplayRequest.request as never,
            confirmReplayRequest.auth,
            ready.id,
            confirmation,
          );
          expect(await execute()).toEqual(receipt);
          expect(await counts()).toEqual([2, 2, 0, 0, 0, 0]);
          const expenses = await prisma.expense.findMany({
            where: { tenantId },
            orderBy: { externalId: "asc" },
          });
          expect(expenses.map((expense) => expense.valorTotal)).toEqual([
            123456, 123456,
          ]);
          // Native planned purchases bind immutable observations to distinct
          // canonical IDs; legacy imported-ledger externalId is not that contract.
          expect(new Set(expenses.map((expense) => expense.id)).size).toBe(2);
          const flows = await prisma.cashFlowEntry.findMany({
            where: { tenantId },
          });
          expect(
            flows.map((flow) => ({
              cents: flow.valor,
              date: flow.data.toISOString().slice(0, 10),
              status: flow.status,
              tipo: flow.tipo,
            })),
          ).toEqual(
            Array.from({ length: 2 }, () => ({
              cents: 123456,
              date: "2026-10-10",
              status: "PLANEJADO",
              tipo: "DESPESA",
            })),
          );
          expect(new Set(flows.map((flow) => flow.expenseId))).toEqual(
            new Set(expenses.map((expense) => expense.id)),
          );
          expect(await immutable()).toEqual(originalEvidence);
          const claimedPurchases = await prisma.importObservation.findMany({
            where: { tenantId, canonicalExpenseId: { not: null } },
          });
          expect(claimedPurchases).toHaveLength(2);
          expect(
            new Set(claimedPurchases.map((row) => row.canonicalExpenseId)),
          ).toEqual(new Set(expenses.map((expense) => expense.id)));
          const ignored = await prisma.importObservation.findUniqueOrThrow({
            where: { id: payment[0].id },
          });
          expect(ignored).toMatchObject({
            canonicalExpenseId: null,
            canonicalReceiptId: null,
            claimSessionId: null,
            claimedAt: null,
          });
          const terminal = await sessions.getSession(auth, ready.id);
          expect(terminal.state).toBe("APPLIED");
          expect(terminal.receipt).toEqual(receipt);
          expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
          return;
        }
        expect(view.lines).toHaveLength(1);
        const evidenceBefore = await prisma.importObservation.findMany({
          where: { tenantId },
          orderBy: { id: "asc" },
        });
        if (format === "PDF") {
          expect(
            view.questions.find((q) => q.field === "dataCompra"),
          ).toHaveProperty("subject");
          expect(
            view.questions.filter((q) => q.field === "dataCompra"),
          ).toHaveLength(1);
          await answer("dataCompra", "2025-09-01");
        }
        await answer("amountMeaning", "total da compra");
        // Source money is already exact. Explicit total meaning resolves the legacy null total,
        // without asking the user to repeat it or reinterpreting it through a provider.
        expect(view.lines[0].amountCents).toBe(123456);
        expect(
          view.questions.filter(
            (q) => q.field === "amountCents" && isPendingImportQuestion(q),
          ),
        ).toHaveLength(0);
        await answer("installmentCount", "1");
        await answer("installmentIndex", "1");
        expect(view.lines[0]).toMatchObject({
          dataCompra: "2025-09-01",
          amountCents: 123456,
          amountMeaning: "TOTAL_PURCHASE",
          installmentCount: 1,
          decision: { kind: "UNRESOLVED" },
          targets: null,
        });
        const covered = [
          "dataCompra",
          "amountMeaning",
          "amountCents",
          "installmentCount",
        ];
        expect(
          view.questions.filter(
            (q) => covered.includes(q.field) && isPendingImportQuestion(q),
          ),
        ).toHaveLength(0);
        expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
        expect(
          await prisma.importObservation.findMany({
            where: { tenantId },
            orderBy: { id: "asc" },
          }),
        ).toEqual(evidenceBefore);
        const reread = await sessions.getSession(auth, view.id);
        expect(reread.lines).toEqual(view.lines);
        if (format === "CSV") {
          // Structurally equivalent pre-fix draft: retained production declarations,
          // missing derived total, and the old generic task. Recovery GET must not write
          // or require replaying the human attestation to eliminate this stale task.
          const stored = await prisma.importSession.findUniqueOrThrow({
            where: { id: view.id },
          });
          const legacy = JSON.parse(stored.draftJson);
          legacy.lines[0].amountCents = null;
          legacy.questions.push({
            id: "legacy_total",
            field: "amountCents",
            lineIds: [legacy.lines[0].id],
            text: "Old total",
          });
          await prisma.importSession.update({
            where: { id: view.id },
            data: { draftJson: JSON.stringify(legacy) },
          });
          const beforeRead = await prisma.importSession.findUniqueOrThrow({
            where: { id: view.id },
          });
          view = await sessions.getSession(auth, view.id);
          expect(view.questions.some((q) => q.id === "legacy_total")).toBe(
            false,
          );
          expect(
            await prisma.importSession.findUniqueOrThrow({
              where: { id: view.id },
            }),
          ).toEqual(beforeRead);
        }
        // Select only; preparation must still ask for the genuine human decision/purpose.
        view = await workflow.edit(auth, view.id, {
          expectedRevision: view.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: [view.lines[0].id],
        });
        view = await workflow.prepare(auth, view.id, {
          expectedRevision: view.revision,
        });
        expect(view.lines[0].amountCents).toBe(123456);
        expect(
          view.questions.filter(
            (q) => covered.includes(q.field) && isPendingImportQuestion(q),
          ),
        ).toHaveLength(0);
        expect(
          view.questions.find(
            (q) => q.field === "decision" && !("subject" in q),
          ),
        ).toBeDefined();
        expect(
          view.questions.find(
            (q) => q.field === "targets" && !("subject" in q),
          ),
        ).toBeDefined();
        expect(view.state).not.toBe("READY");
        await expect(
          workflow.confirm(
            auth,
            view.id,
            {
              expectedRevision: view.revision,
              proposalHash: "a".repeat(64),
              financialRequestId: randomUUID(),
              nonce: null,
            },
            {},
          ),
        ).rejects.toBeDefined();
        // Human-controlled non-documentary choices remain on their existing production path.
        view = await workflow.edit(auth, view.id, {
          expectedRevision: view.revision,
          questionId: null,
          selectedLineIds: view.selectedLineIds,
          replaceLines: view.lines.map((line) => ({
            ...line,
            firstDueDate: "2026-10-10",
            tipoDespesa: ExpenseType.OUTROS,
            targets: [],
            decision: { kind: "CREATE", acceptNaturalDuplicate: false },
          })),
        });
        view = await workflow.prepare(auth, view.id, {
          expectedRevision: view.revision,
        });
        expect(
          view.questions.filter(
            (q) => covered.includes(q.field) && isPendingImportQuestion(q),
          ),
        ).toHaveLength(0);
        if (format === "CSV") expect(view.state).toBe("READY");
        else {
          // Original no-year identity has no ordinal: documentary answers cannot invent
          // immutable financial identity. Keep that separate pre-existing readiness gate.
          expect(view.reviewBlockers).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                resolution: "SEARCH_IDENTITY_UNAVAILABLE",
              }),
            ]),
          );
          expect(view.state).not.toBe("READY");
        }
        expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
        const persisted = await prisma.importSession.findUniqueOrThrow({
          where: { id: view.id },
        });
        expect(persisted.financialRequestId).toBeNull();
        expect(persisted.challengeJson).toBeNull();
        expect(persisted.receiptJson).toBeNull();
      } finally {
        await registry.shutdown(1000);
        rmSync(root, { recursive: true, force: true });
        await prisma.$transaction(async (tx) => {
          if (documentedYear) {
            await tx.cashFlowEntry.deleteMany({ where: { tenantId } });
            await tx.importObservation.deleteMany({ where: { tenantId } });
            await tx.expense.deleteMany({ where: { tenantId } });
          }
          await tx.importSessionArtifact.deleteMany({ where: { tenantId } });
          await tx.importObservation.deleteMany({ where: { tenantId } });
          await tx.importSession.deleteMany({ where: { tenantId } });
          await tx.importArtifact.deleteMany({ where: { tenantId } });
          await tx.creditCard.deleteMany({ where: { tenantId } });
          await tx.project.deleteMany({ where: { tenantId } });
          await tx.user.deleteMany({ where: { tenantId } });
          await tx.tenant.deleteMany({ where: { id: tenantId } });
        });
      }
    },
  );
});
