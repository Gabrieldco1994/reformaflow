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
import type { UiImportGrantScope } from "./import-session.contract";
import { ImportUploadService } from "./vault/import-upload.service";
import { VaultFdRegistry } from "./vault/vault-fd-registry";
import { VaultStorage } from "./vault/vault-storage";
import { PurgeCoordinator } from "./vault/vault-purger";
import type { VaultBootHandle, VaultRuntime } from "./vault/vault-boot";

/** Synthetic textual bytes only; no parser result, original identity or draft is seeded. */
function invoice(): Buffer {
  const text = [
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

  it.each(["PDF", "CSV"] as const)(
    "%s: native facts retire duplicate tasks without gaining financial authority",
    async (format) => {
      expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
      await prisma.$connect();
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
          format === "PDF"
            ? invoice()
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
                fileName: `invoice.${format.toLowerCase()}`,
                declaredBytes: bytes.length,
                mime: format === "PDF" ? "application/pdf" : "text/csv",
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
