import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ExpenseType, PaymentForm, ProjectType } from "@reformaflow/domain";

const CANONICAL_RETENTION_MIGRATION =
  "20261009193000_canonical_import_linkage_retention";
const RETIREMENT_MIGRATION = "20261010100000_retire_unlinked_import_artifacts";

async function insertHistoricalSession(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    ownerProjectId: string;
    ownerUserId: string;
    cardId: string;
    state: "DRAFT" | "APPLIED";
    revision: number;
    createRequestId: string;
    createPayloadHash: string;
    instant: Date;
    expiresAt: Date;
    draftJson: string;
    proposalHash?: string;
    financialRequestId?: string;
    confirmedRevision?: number;
    confirmedSessionVersion?: number;
    confirmedAt?: Date;
    receiptJson?: string;
    closedAt?: Date;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  const kind = "CREATE_CARD_PURCHASES";
  const consentPolicyVersion = 1;
  await prisma.$executeRaw`
    INSERT INTO import_sessions (
      id, tenant_id, owner_user_id, owner_project_id, card_id, kind, state,
      revision, create_request_id, create_payload_hash,
      consent_policy_version, consented_at, updated_at, last_user_edit_at,
      expires_at, draft_json, proposal_hash, financial_request_id,
      confirmed_revision, confirmed_session_version, confirmed_at,
      receipt_json, closed_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.ownerUserId}, ${input.ownerProjectId},
      ${input.cardId}, ${kind}, ${input.state}, ${input.revision},
      ${input.createRequestId}, ${input.createPayloadHash},
      ${consentPolicyVersion}, ${input.instant}, ${input.instant},
      ${input.instant}, ${input.expiresAt}, ${input.draftJson},
      ${input.proposalHash ?? null}, ${input.financialRequestId ?? null},
      ${input.confirmedRevision ?? null},
      ${input.confirmedSessionVersion ?? null}, ${input.confirmedAt ?? null},
      ${input.receiptJson ?? null}, ${input.closedAt ?? null}
    )`;
  return { id };
}

async function readHistoricalSession(
  prisma: PrismaClient,
  id: string,
): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT
      id, tenant_id, owner_user_id, owner_project_id, card_id,
      protocol_version, kind, state, revision, create_request_id,
      create_payload_hash, consent_policy_version, consented_at, created_at,
      updated_at, last_user_edit_at, expires_at, draft_json, search_json,
      proposal_json, proposal_hash, preflight_hash, challenge_json,
      prepare_generation, prepare_lease_json, financial_request_id,
      confirmed_revision, confirmed_session_version, confirmed_at,
      receipt_json, closed_at
    FROM import_sessions
    WHERE id = ${id}`;
  if (rows.length !== 1) {
    throw new Error(`historical import session ${id} was not found`);
  }
  return rows[0];
}

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
      // Preserve the named 71 -> 72 historical boundary even as later
      // migrations are added to the repository.
      const retirementIndex = migrations.indexOf(RETIREMENT_MIGRATION);
      expect(retirementIndex).toBe(71);
      expect(migrations[retirementIndex - 1]).toBe(
        CANONICAL_RETENTION_MIGRATION,
      );
      const historicalMigrations = migrations.slice(0, retirementIndex);
      mkdirSync(migrationRoot);
      cpSync(join(root, "prisma/schema.prisma"), schema);
      cpSync(
        join(committed, "migration_lock.toml"),
        join(migrationRoot, "migration_lock.toml"),
      );
      for (const name of historicalMigrations)
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
        const session = await insertHistoricalSession(prisma, {
          tenantId: tenant.id,
          ownerProjectId: project.id,
          ownerUserId: user.id,
          cardId: card.id,
          state: "APPLIED",
          revision: 2,
          createRequestId: "interrupted-purge-create",
          createPayloadHash: "a".repeat(64),
          instant,
          expiresAt: new Date("2026-10-16T20:00:00.000Z"),
          draftJson: '{"legacy":"terminal"}',
          proposalHash: "d".repeat(64),
          financialRequestId: "interrupted-purge-financial-request",
          confirmedRevision: 2,
          confirmedSessionVersion: 0,
          confirmedAt: instant,
          receiptJson: '{"version":1,"immutable":"APPLIED receipt bytes"}',
          closedAt: instant,
        });
        const sessionBefore = await readHistoricalSession(prisma, session.id);
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
          const intake = await insertHistoricalSession(prisma, {
            tenantId: tenant.id,
            ownerProjectId: project.id,
            ownerUserId: user.id,
            cardId: card.id,
            state: "DRAFT",
            revision: 1,
            createRequestId: "never-claimed-intake",
            createPayloadHash: "c".repeat(64),
            instant,
            expiresAt: new Date("2026-10-16T20:00:00.000Z"),
            draftJson: '{"legacy":"active intake"}',
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
        const appliedBefore = await prisma.$queryRaw<
          Array<{ migration_name: string }>
        >`SELECT migration_name FROM _prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
          ORDER BY migration_name`;
        expect(
          appliedBefore.map(({ migration_name }) => migration_name),
        ).toEqual(historicalMigrations);
        await prisma.$disconnect();
        cpSync(
          join(committed, RETIREMENT_MIGRATION),
          join(migrationRoot, RETIREMENT_MIGRATION),
          { recursive: true },
        );
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
        expect(await readHistoricalSession(prisma, session.id)).toEqual(
          sessionBefore,
        );
        expect(
          await prisma.$queryRaw`SELECT * FROM expenses WHERE id = ${expense.id}`,
        ).toEqual(financeBefore);
        expect(
          await prisma.$queryRaw`SELECT * FROM receipts WHERE id = ${receipt.id}`,
        ).toEqual(receiptsBefore);
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
        const appliedAfter = await prisma.$queryRaw<
          Array<{ migration_name: string }>
        >`SELECT migration_name FROM _prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
          ORDER BY migration_name`;
        expect(
          appliedAfter.map(({ migration_name }) => migration_name),
        ).toEqual([...historicalMigrations, RETIREMENT_MIGRATION]);
        expect(appliedAfter).toHaveLength(72);
      } finally {
        await prisma.$disconnect();
        rmSync(fixture, { recursive: true });
      }
    },
    60_000,
  );
});
