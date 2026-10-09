import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ExpenseType, PaymentForm, ProjectType } from "@reformaflow/domain";

// setupFiles loads test-db-env.cjs before this module initializes Prisma.
describe("guarded nullable identity upgrade at interrupted purge", () => {
  it.each([
    "live-claims",
    "unclaimed-purging",
    "never-claimed-intake",
  ] as const)(
    "copies %s without confusing financial retention with original retention",
    async (scenario) => {
      const root = resolve(__dirname, "../../../../..");
      const fixture = mkdtempSync(
        join(root, "prisma/.tmp-claimed-purging-upgrade-"),
      );
      const database = join(fixture, "test-upgrade.db");
      expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
      expect(database).not.toContain("dev.db");
      const guard = require("../../../../../scripts/test-db-env.cjs") as {
        forbiddenReason(url: string): string | null;
      };
      expect(guard.forbiddenReason(`file:${database}`)).toBeNull();
      const schema = join(fixture, "schema.prisma");
      const migrationRoot = join(fixture, "migrations");
      const committed = join(root, "prisma/migrations");
      const migrations = readdirSync(committed)
        .filter((name) => /^\d/.test(name))
        .sort();
      // QA f2d4c90 fixture: seed through 71, then deploy the unshipped table copy.
      expect(migrations).toHaveLength(72);
      const previousCount = 71;
      mkdirSync(migrationRoot);
      cpSync(join(root, "prisma/schema.prisma"), schema);
      cpSync(
        join(committed, "migration_lock.toml"),
        join(migrationRoot, "migration_lock.toml"),
      );
      for (const name of migrations.slice(0, previousCount))
        cpSync(join(committed, name), join(migrationRoot, name), {
          recursive: true,
        });
      const deploy = () =>
        execFileSync(
          process.execPath,
          [
            require.resolve("prisma/build/index.js"),
            "migrate",
            "deploy",
            `--schema=${schema}`,
          ],
          {
            cwd: root,
            env: { ...process.env, DATABASE_URL: `file:${database}` },
            stdio: "pipe",
          },
        );
      deploy();
      const prisma = new PrismaClient({
        datasources: { db: { url: `file:${database}` } },
      });
      const instant = new Date("2026-10-09T20:00:00.000Z");
      try {
        expect(await prisma.$queryRaw`PRAGMA foreign_keys`).toEqual([
          { foreign_keys: 1n },
        ]);
        const tenant = await prisma.tenant.create({
          data: { name: "Interrupted purge upgrade" },
        });
        const project = await prisma.project.create({
          data: {
            tenantId: tenant.id,
            name: "Interrupted purge upgrade",
            type: ProjectType.PESSOAL,
          },
        });
        const user = await prisma.user.create({
          data: {
            tenantId: tenant.id,
            username: "interrupted-purge-owner",
            name: "Upgrade owner",
            role: "ADMIN",
          },
        });
        const card = await prisma.creditCard.create({
          data: {
            tenantId: tenant.id,
            projectId: project.id,
            nickname: "Upgrade",
            institution: "Upgrade",
            last4: "1234",
            closingDay: 5,
            dueDay: 10,
          },
        });
        const session = await prisma.importSession.create({
          data: {
            tenantId: tenant.id,
            ownerProjectId: project.id,
            ownerUserId: user.id,
            cardId: card.id,
            kind: "CREATE_CARD_PURCHASES",
            state: "APPLIED",
            revision: 2,
            createRequestId: "interrupted-purge-create",
            createPayloadHash: "a".repeat(64),
            consentPolicyVersion: 1,
            consentedAt: instant,
            lastUserEditAt: instant,
            expiresAt: new Date("2026-10-16T20:00:00.000Z"),
            draftJson: '{"legacy":"terminal"}',
            proposalHash: "d".repeat(64),
            financialRequestId: "interrupted-purge-financial-request",
            confirmedRevision: 2,
            confirmedSessionVersion: 0,
            confirmedAt: instant,
            receiptJson: '{"version":1,"immutable":"APPLIED receipt bytes"}',
            closedAt: instant,
          },
        });
        const expense = await prisma.expense.create({
          data: {
            tenantId: tenant.id,
            projectId: project.id,
            tipoDespesa: ExpenseType.OUTROS,
            valor: 20696,
            quantidade: 1,
            valorTotal: 20696,
            formaPagamento: PaymentForm.A_VISTA,
            titulo: "Live canonical expense",
          },
        });
        const receipt = await prisma.receipt.create({
          data: {
            tenantId: tenant.id,
            projectId: project.id,
            valor: 20696,
            data: instant,
            tipo: "PAGAMENTO",
            status: "PREVISTO",
          },
        });
        const artifact = await prisma.importArtifact.create({
          data: {
            tenantId: tenant.id,
            ownerProjectId: project.id,
            documentSha256: "b".repeat(64),
            verifiedBytes: 100,
            detectedFormat: "CSV",
            state:
              scenario === "never-claimed-intake" ? "EXTRACTED" : "PURGING",
            storageKey: "t/10000000-0000-4000-8000-000000000001/g2/blob",
            parserVersion: "fixture-parser-v1",
            extractionJson: '{"version":1,"immutable":"extraction bytes"}',
            parseGeneration: 7,
          },
        });
        if (scenario === "never-claimed-intake") {
          const intake = await prisma.importSession.create({
            data: {
              tenantId: tenant.id,
              ownerProjectId: project.id,
              ownerUserId: user.id,
              cardId: card.id,
              kind: "CREATE_CARD_PURCHASES",
              state: "DRAFT",
              revision: 1,
              createRequestId: "never-claimed-intake",
              createPayloadHash: "c".repeat(64),
              consentPolicyVersion: 1,
              consentedAt: instant,
              lastUserEditAt: instant,
              expiresAt: new Date("2026-10-16T20:00:00.000Z"),
              draftJson: '{"legacy":"active intake"}',
            },
          });
          await prisma.importSessionArtifact.create({
            data: {
              tenantId: tenant.id,
              ownerProjectId: project.id,
              sessionId: intake.id,
              artifactId: artifact.id,
              position: 0,
              fileName: "never-claimed.csv",
              declaredMime: "text/csv",
              declaredBytes: 100,
              reservedBytes: 0,
              state: "ATTACHED",
              verifiedAt: instant,
            },
          });
        }
        const claims = [];
        if (scenario === "live-claims")
          for (const kind of ["Expense", "Receipt"] as const)
            claims.push(
              await prisma.importObservation.create({
                data: {
                  tenantId: tenant.id,
                  ownerProjectId: project.id,
                  artifactId: artifact.id,
                  reference: `live-${kind}`,
                  evidenceJson: "{}",
                  claimVersion: 1,
                  canonicalProjectId: project.id,
                  canonicalExpenseId: kind === "Expense" ? expense.id : null,
                  canonicalReceiptId: kind === "Receipt" ? receipt.id : null,
                  canonicalIndex: kind === "Expense" ? 0 : null,
                  claimSessionId: session.id,
                  claimReceiptJson: '{"kind":"SESSION","immutable":"claim"}',
                  claimedAt: instant,
                },
              }),
            );
        const financeBefore = await prisma.$queryRaw`
          SELECT * FROM expenses WHERE id = ${expense.id}`;
        const receiptsBefore = await prisma.$queryRaw`
          SELECT * FROM receipts WHERE id = ${receipt.id}`;
        await prisma.$disconnect();
        for (const name of migrations.slice(previousCount))
          cpSync(join(committed, name), join(migrationRoot, name), {
            recursive: true,
          });
        deploy();
        const after = await prisma.importArtifact.findUniqueOrThrow({
          where: { id: artifact.id },
        });
        if (scenario === "unclaimed-purging")
          expect(after).toMatchObject({
            documentSha256: null,
            extractionJson: null,
            parserVersion: null,
            state: "PURGING",
            storageKey: artifact.storageKey,
            leaseSessionId: null,
            leaseSessionVersion: null,
            leaseExpiresAt: null,
            leaseTokenExpiresAt: null,
          });
        else expect(after).toEqual(artifact);
        expect(
          await prisma.importObservation.findMany({
            where: { artifactId: artifact.id },
            orderBy: { reference: "asc" },
          }),
        ).toEqual(claims);
        expect(
          await prisma.importSession.findUniqueOrThrow({
            where: { id: session.id },
          }),
        ).toEqual(session);
        expect(
          await prisma.$queryRaw`SELECT * FROM expenses WHERE id = ${expense.id}`,
        ).toEqual(financeBefore);
        expect(
          await prisma.$queryRaw`SELECT * FROM receipts WHERE id = ${receipt.id}`,
        ).toEqual(receiptsBefore);
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      } finally {
        await prisma.$disconnect();
        rmSync(fixture, { recursive: true });
      }
    },
    60_000,
  );
});
