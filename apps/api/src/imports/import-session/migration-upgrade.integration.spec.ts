import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ExpenseType, PaymentForm, ProjectType } from "@reformaflow/domain";
import type { StoredSourceScheduleV1 } from "../../expense/documented-schedule.types";

const LEGACY_BOUNDARY_MIGRATION = "20260923190000_additive_partial_settlements";
const CURRENT_MIGRATION_COUNT = 76;
const CURRENT_MIGRATION_SUFFIX = [
  "20260923210000_documented_expense_schedule",
  "20260929010000_import_session_bootstrap",
  "20261009193000_canonical_import_linkage_retention",
  "20261010100000_retire_unlinked_import_artifacts",
  "20261013180000_import_pdf_ocr_runtime",
  "20261013183000_import_ocr_usage_budget",
  "20261013233000_import_ocr_usage_foreign_keys",
  "20261014004500_import_ocr_usage_provenance",
];
const IMPORT_SESSION_BOOTSTRAP_MIGRATION =
  "20260929010000_import_session_bootstrap";
const CANONICAL_RETENTION_MIGRATION =
  "20261009193000_canonical_import_linkage_retention";
const RETIREMENT_MIGRATION = "20261010100000_retire_unlinked_import_artifacts";

type HistoricalSessionInput = {
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
};

async function insertHistoricalSession(
  prisma: PrismaClient,
  input: HistoricalSessionInput,
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
type TestDbGuard = {
  REPO_ROOT: string;
  forbiddenReason(url: string): string | null;
  resolveSqlitePath(url: string): string | null;
  resolveRealSqlitePath(url: string): string | null;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbGuard =
  require("../../../../../scripts/test-db-env.cjs") as TestDbGuard;

describe("CSV schema upgrade from the committed legacy structure", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  function assertDisposableDatabase(database: string): void {
    const url = `file:${database}`;
    expect(dbGuard.forbiddenReason(url)).toBeNull();
    expect(dbGuard.resolveSqlitePath(url)).toBe(database);
    expect(dbGuard.resolveRealSqlitePath(url)).toBe(database);
    expect(dbGuard.REPO_ROOT).toBe(resolve(__dirname, "../../../../.."));
    expect(database.toLowerCase()).not.toContain("dev.db");
  }

  it("upgrades the named 68-migration boundary through all 76 migrations without changing legacy financial rows or foreign keys", async () => {
    const root = resolve(__dirname, "../../../../..");
    const fixture = mkdtempSync(
      join(root, "prisma", ".tmp-maria-csv-upgrade-"),
    );
    fixtures.push(fixture);
    const database = join(fixture, "test-upgrade.db");
    assertDisposableDatabase(database);
    const schema = join(fixture, "schema.prisma");
    const migrationRoot = join(fixture, "migrations");
    mkdirSync(migrationRoot);
    // Like claimed-purging-upgrade.integration.spec.ts, deploy a committed
    // migration prefix. migrate deploy executes SQL, not the schema models:
    // the named 68-migration prefix reconstructs the actual legacy structure even
    // in a depth-one CI checkout, without requiring a historical git object.
    cpSync(join(root, "prisma/schema.prisma"), schema);
    const committed = join(root, "prisma/migrations");
    const migrations = readdirSync(committed)
      .filter((name) => /^\d/.test(name))
      .sort();
    expect(migrations).toHaveLength(CURRENT_MIGRATION_COUNT);
    const legacyBoundaryIndex = migrations.indexOf(LEGACY_BOUNDARY_MIGRATION);
    expect(legacyBoundaryIndex).toBe(67);
    expect(migrations.slice(legacyBoundaryIndex + 1)).toEqual(
      CURRENT_MIGRATION_SUFFIX,
    );
    cpSync(
      join(committed, "migration_lock.toml"),
      join(migrationRoot, "migration_lock.toml"),
    );
    const legacyMigrations = migrations.slice(0, legacyBoundaryIndex + 1);
    for (const name of legacyMigrations)
      cpSync(join(committed, name), join(migrationRoot, name), {
        recursive: true,
      });
    const deploy = (): void => {
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
    };
    deploy();
    const prisma = new PrismaClient({
      datasources: { db: { url: `file:${database}` } },
    });
    try {
      const legacyColumns = await prisma.$queryRaw<
        Array<{ name: string }>
      >`PRAGMA table_info(expenses)`;
      expect(legacyColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "valor",
          "valor_total",
          "paid_parcelas",
          "installment_date_overrides",
        ]),
      );
      expect(legacyColumns.map(({ name }) => name)).not.toContain(
        "documented_schedule",
      );
      expect(
        await prisma.$queryRaw`
          SELECT name FROM sqlite_master WHERE type = 'table'
            AND name IN ('import_sessions', 'import_artifacts', 'import_observations')`,
      ).toEqual([]);
      expect(await prisma.$queryRaw`PRAGMA foreign_keys`).toEqual([
        { foreign_keys: 1n },
      ]);
      const tenant = await prisma.tenant.create({
        data: { name: "Legacy structural fixture" },
      });
      const project = await prisma.project.create({
        data: {
          tenantId: tenant.id,
          name: "Legacy fixture",
          type: ProjectType.PESSOAL,
        },
      });
      const expenseId = "legacy-csv-upgrade-expense";
      const instant = new Date("2026-09-23T20:00:00.000Z");
      await prisma.$executeRaw`
        INSERT INTO expenses (id, tenant_id, project_id, tipo_despesa, valor, quantidade, valor_total,
          forma_pagamento, titulo, paid_parcelas, installment_date_overrides, created_at, updated_at)
        VALUES (${expenseId}, ${tenant.id}, ${project.id}, ${ExpenseType.OUTROS}, ${101}, ${1}, ${101},
          ${PaymentForm.A_VISTA}, ${"Legacy retained purchase"}, ${"[0]"}, ${'{"0":"2026-09-24"}'}, ${instant}, ${instant})`;
      const before = await prisma.$queryRaw<
        Record<string, unknown>[]
      >`SELECT * FROM expenses WHERE id = ${expenseId}`;
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        id: expenseId,
        valor: 101,
        quantidade: 1,
        valor_total: 101,
        paid_parcelas: "[0]",
        installment_date_overrides: '{"0":"2026-09-24"}',
      });
      const appliedBefore = await prisma.$queryRaw<
        Array<{ migration_name: string }>
      >`SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name ASC`;
      expect(appliedBefore.map(({ migration_name }) => migration_name)).toEqual(
        legacyMigrations,
      );
      await prisma.$disconnect();
      cpSync(join(root, "prisma/schema.prisma"), schema);
      for (const name of migrations.slice(legacyBoundaryIndex + 1))
        cpSync(join(committed, name), join(migrationRoot, name), {
          recursive: true,
        });
      deploy();
      const after = await prisma.$queryRaw<
        Record<string, unknown>[]
      >`SELECT * FROM expenses WHERE id = ${expenseId}`;
      expect(
        after.map(({ documented_schedule, ...legacy }) => {
          expect(documented_schedule).toBeNull();
          return legacy;
        }),
      ).toEqual(before);
      expect(
        await prisma.$queryRaw<unknown[]>`PRAGMA foreign_key_check`,
      ).toEqual([]);
      const applied = await prisma.$queryRaw<unknown[]>`
        SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      expect(applied).toHaveLength(CURRENT_MIGRATION_COUNT);
      const records = await prisma.$queryRaw<
        Array<{ migration_name: string; checksum: string }>
      >`SELECT migration_name, checksum FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name ASC`;
      expect(records.map(({ migration_name }) => migration_name)).toEqual(
        migrations,
      );
      expect(
        records.map(({ migration_name, checksum }) => [
          migration_name,
          checksum,
        ]),
      ).toEqual(
        migrations.map((migrationName) => [
          migrationName,
          createHash("sha256")
            .update(
              readFileSync(join(committed, migrationName, "migration.sql")),
            )
            .digest("hex"),
        ]),
      );
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  const verifyPolicyUpgrade = async (
    scenario: "dead-claims" | "pre-existing-orphans",
  ) => {
    const root = resolve(__dirname, "../../../../..");
    const fixture = mkdtempSync(
      join(root, "prisma", ".tmp-maria-linkage-upgrade-"),
    );
    fixtures.push(fixture);
    const database = join(fixture, "test-upgrade.db");
    assertDisposableDatabase(database);
    const schema = join(fixture, "schema.prisma");
    const migrationRoot = join(fixture, "migrations");
    const committed = join(root, "prisma/migrations");
    const migrations = readdirSync(committed)
      .filter((name) => /^\d/.test(name))
      .sort();
    const bootstrapIndex = migrations.indexOf(
      IMPORT_SESSION_BOOTSTRAP_MIGRATION,
    );
    expect(bootstrapIndex).toBe(69);
    expect(migrations[bootstrapIndex + 1]).toBe(CANONICAL_RETENTION_MIGRATION);
    expect(migrations[bootstrapIndex + 2]).toBe(RETIREMENT_MIGRATION);
    const historicalMigrations = migrations.slice(0, bootstrapIndex + 1);
    const policyMigrations = [
      CANONICAL_RETENTION_MIGRATION,
      RETIREMENT_MIGRATION,
    ];
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
        data: { name: "Legacy tombstone linkage" },
      });
      const project = await prisma.project.create({
        data: {
          tenantId: tenant.id,
          name: "Legacy tombstone linkage",
          type: ProjectType.PESSOAL,
        },
      });
      const user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          username: "legacy-linkage-owner",
          name: "Legacy owner",
          role: "ADMIN",
        },
      });
      const card = await prisma.creditCard.create({
        data: {
          tenantId: tenant.id,
          projectId: project.id,
          nickname: "Legacy",
          institution: "Legacy",
          last4: "1234",
          closingDay: 5,
          dueDay: 10,
        },
      });
      // Structurally equivalent pre-upgrade rows, not an E2E import simulation.
      const expenseId = "legacy-linkage-expense";
      const schedule: StoredSourceScheduleV1 = {
        version: 1,
        kind: "source",
        tenantId: tenant.id,
        sourceExpenseId: expenseId,
        sourceProjectId: project.id,
        cardId: card.id,
        recordedByUserId: user.id,
        recordedAt: instant.toISOString(),
        importId: "legacy-card-import",
        externalId: "legacy-expense-external",
        occurrences: [
          {
            index: 0,
            parcela: "1/2",
            valor: 10348,
            data: "2026-10-10T12:00:00.000Z",
            invoiceDueMonth: "2026-10",
            amountEvidence: null,
            cycleEvidence: null,
          },
          {
            index: 1,
            parcela: "2/2",
            valor: 10348,
            data: "2026-11-10T12:00:00.000Z",
            invoiceDueMonth: "2026-11",
            amountEvidence: null,
            cycleEvidence: null,
          },
        ],
        projections: [],
        lastOperation: null,
      };
      const expense = await prisma.expense.create({
        data: {
          id: expenseId,
          tenantId: tenant.id,
          projectId: project.id,
          tipoDespesa: ExpenseType.OUTROS,
          valor: 20696,
          quantidade: 1,
          valorTotal: 20696,
          formaPagamento: PaymentForm.PARCELADO,
          quantidadeParcela: 2,
          dataInicioParcela: instant,
          paidParcelas: "[0]",
          installmentDateOverrides: '{"1":"2026-11-11"}',
          documentedSchedule: JSON.stringify(schedule),
          origin: "import",
          importId: "legacy-card-import",
          externalId: "legacy-expense-external",
          dedupeKeyStrong: "legacy-expense-strong",
          dedupeKeyNatural: "legacy-expense-natural",
          deletedAt: instant,
        },
      });
      const receipt = await prisma.receipt.create({
        data: {
          tenantId: tenant.id,
          projectId: project.id,
          valor: 20696,
          data: instant,
          tipo: "PAGAMENTO",
          status: "EM_CAIXA",
          origin: "import",
          importId: "legacy-bank-import",
          externalId: "legacy-receipt-external",
          dedupeKeyStrong: "legacy-receipt-strong",
          dedupeKeyNatural: "legacy-receipt-natural",
          deletedAt: instant,
        },
      });
      const survivor = await prisma.expense.create({
        data: {
          tenantId: tenant.id,
          projectId: project.id,
          tipoDespesa: ExpenseType.OUTROS,
          valor: 101,
          quantidade: 1,
          valorTotal: 101,
          formaPagamento: PaymentForm.A_VISTA,
        },
      });
      const session = await insertHistoricalSession(prisma, {
        tenantId: tenant.id,
        ownerProjectId: project.id,
        ownerUserId: user.id,
        cardId: card.id,
        state: "APPLIED",
        revision: 2,
        createRequestId: "legacy-create",
        createPayloadHash: "a".repeat(64),
        instant,
        expiresAt: new Date("2026-10-16T20:00:00.000Z"),
        draftJson: '{"legacy":"terminal"}',
        proposalHash: "b".repeat(64),
        financialRequestId: "legacy-financial-request",
        confirmedRevision: 2,
        confirmedSessionVersion: 0,
        confirmedAt: instant,
        closedAt: instant,
        receiptJson: '{"version":1,"legacy":"immutable APPLIED bytes"}',
      });
      const sessionBefore = await readHistoricalSession(prisma, session.id);
      const source = await prisma.importArtifact.create({
        data: {
          tenantId: tenant.id,
          ownerProjectId: project.id,
          documentSha256: "c".repeat(64),
          verifiedBytes: 100,
          detectedFormat: "CSV",
          state: "PURGED",
        },
      });
      const baseClaim = {
        tenantId: tenant.id,
        ownerProjectId: project.id,
        artifactId: source.id,
        evidenceJson: "{}",
        claimVersion: 1,
        canonicalProjectId: project.id,
        claimSessionId: session.id,
        claimReceiptJson: '{"kind":"SESSION","legacy":"claim"}',
        claimedAt: instant,
      };
      if (scenario === "dead-claims") {
        await prisma.importObservation.create({
          data: {
            ...baseClaim,
            reference: "deleted-expense",
            canonicalExpenseId: expense.id,
          },
        });
        await prisma.importObservation.create({
          data: {
            ...baseClaim,
            reference: "deleted-receipt",
            canonicalReceiptId: receipt.id,
          },
        });
      }
      const retainedClaim = await prisma.importObservation.create({
        data: {
          ...baseClaim,
          reference: "surviving-expense",
          canonicalExpenseId: survivor.id,
        },
      });
      const orphan = async (hash: string, storageKey: string | null) =>
        prisma.importArtifact.create({
          data: {
            tenantId: tenant.id,
            ownerProjectId: project.id,
            documentSha256: hash.repeat(64),
            verifiedBytes: 100,
            detectedFormat: "CSV",
            state: storageKey ? "EXTRACTED" : "PURGED",
            storageKey,
            extractionJson: storageKey
              ? '{"version":1,"legacy":"private"}'
              : null,
          },
        });
      const storageLess = await orphan("d", null);
      const awaitingPurge = await orphan(
        "e",
        "t/10000000-0000-4000-8000-000000000001/g2/blob",
      );
      const protectedSource = await orphan(
        "f",
        "t/10000000-0000-4000-8000-000000000002/g2/blob",
      );
      const liveSession = await insertHistoricalSession(prisma, {
        tenantId: tenant.id,
        ownerProjectId: project.id,
        ownerUserId: user.id,
        cardId: card.id,
        state: "DRAFT",
        revision: 1,
        createRequestId: "legacy-active-reference",
        createPayloadHash: "1".repeat(64),
        instant,
        expiresAt: new Date("2026-10-16T20:00:00.000Z"),
        draftJson: '{"legacy":"active-consent"}',
      });
      const liveSessionBefore = await readHistoricalSession(
        prisma,
        liveSession.id,
      );
      const ref = async (
        artifactId: string,
        position: number,
        active = false,
      ) =>
        prisma.importSessionArtifact.create({
          data: {
            tenantId: tenant.id,
            ownerProjectId: project.id,
            sessionId: active ? liveSession.id : session.id,
            artifactId,
            position,
            fileName: active ? "protected.csv" : "document",
            declaredMime: "text/csv",
            declaredBytes: 100,
            reservedBytes: 0,
            state: active ? "ATTACHED" : "RELEASED",
            verifiedAt: instant,
            releasedAt: active ? null : instant,
          },
        });
      const released = await ref(storageLess.id, 0);
      const purgeRef = await ref(awaitingPurge.id, 1);
      const protectedRef = await ref(protectedSource.id, 0, true);
      const sharedReleasedRef = await ref(protectedSource.id, 2);
      const emptyEvidence = async (artifactId: string) =>
        prisma.importObservation.create({
          data: {
            tenantId: tenant.id,
            ownerProjectId: project.id,
            artifactId,
            reference: "legacy:unclaimed-empty",
            evidenceJson: "{}",
          },
        });
      const orphanEmpty = await emptyEvidence(storageLess.id);
      const purgeEmpty = await emptyEvidence(awaitingPurge.id);
      const protectedEmpty = await emptyEvidence(protectedSource.id);
      expect(await prisma.importObservation.count()).toBe(
        scenario === "dead-claims" ? 6 : 4,
      );
      const financialBefore = await prisma.$queryRaw`
        SELECT * FROM expenses WHERE tenant_id = ${tenant.id} ORDER BY id`;
      const receiptsBefore = await prisma.$queryRaw`
        SELECT * FROM receipts WHERE tenant_id = ${tenant.id} ORDER BY id`;
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      const appliedBefore = await prisma.$queryRaw<
        Array<{ migration_name: string }>
      >`SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name`;
      expect(appliedBefore.map(({ migration_name }) => migration_name)).toEqual(
        historicalMigrations,
      );
      await prisma.$disconnect();
      for (const name of policyMigrations)
        cpSync(join(committed, name), join(migrationRoot, name), {
          recursive: true,
        });
      deploy();
      expect(
        await prisma.$queryRaw`
        SELECT * FROM expenses WHERE tenant_id = ${tenant.id} ORDER BY id`,
      ).toEqual(financialBefore);
      expect(
        await prisma.$queryRaw`
        SELECT * FROM receipts WHERE tenant_id = ${tenant.id} ORDER BY id`,
      ).toEqual(receiptsBefore);
      expect(await readHistoricalSession(prisma, session.id)).toEqual(
        sessionBefore,
      );
      expect(
        await prisma.importObservation.findMany({
          where: { artifactId: source.id },
        }),
      ).toEqual([retainedClaim]);
      expect(
        await prisma.importArtifact.findUnique({ where: { id: source.id } }),
      ).toEqual(source);
      expect(
        await prisma.importArtifact.findUnique({
          where: { id: storageLess.id },
        }),
      ).toBeNull();
      expect(
        await prisma.importSessionArtifact.findUnique({
          where: { id: released.id },
        }),
      ).toBeNull();
      for (const row of [orphanEmpty, purgeEmpty])
        expect(
          await prisma.importObservation.findUnique({
            where: { id: row.id },
          }),
        ).toBeNull();
      const coordination = await prisma.importArtifact.findUniqueOrThrow({
        where: { id: awaitingPurge.id },
      });
      // SQL cannot erase originals without the runtime's fencing/drain/absence
      // proof. Retain only that purge coordination, not reusable identity.
      expect(coordination).toMatchObject({
        state: "PURGING",
        storageKey: awaitingPurge.storageKey,
        extractionJson: null,
        leaseSessionId: null,
        leaseSessionVersion: null,
        leaseTokenExpiresAt: null,
        leaseExpiresAt: null,
      });
      expect(coordination.documentSha256).not.toBe(
        awaitingPurge.documentSha256,
      );
      for (const row of [storageLess, awaitingPurge])
        expect(
          await prisma.importArtifact.findMany({
            where: {
              tenantId: tenant.id,
              documentSha256: row.documentSha256,
            },
          }),
        ).toEqual([]);
      // A released association may be deleted or detached while storage purge
      // is pending, but cannot keep a documentary/dedupe link to the original.
      expect(
        await prisma.importSessionArtifact.count({
          where: { id: purgeRef.id, artifactId: awaitingPurge.id },
        }),
      ).toBe(0);
      expect(
        await prisma.importArtifact.findUnique({
          where: { id: protectedSource.id },
        }),
      ).toEqual(protectedSource);
      expect(
        await prisma.importSessionArtifact.findUnique({
          where: { id: protectedRef.id },
        }),
      ).toEqual(protectedRef);
      expect(
        await prisma.importSessionArtifact.findUnique({
          where: { id: sharedReleasedRef.id },
        }),
      ).toEqual(sharedReleasedRef);
      expect(
        await prisma.importObservation.findUnique({
          where: { id: protectedEmpty.id },
        }),
      ).toEqual(protectedEmpty);
      expect(await readHistoricalSession(prisma, liveSession.id)).toEqual(
        liveSessionBefore,
      );
      expect(await prisma.$queryRaw`PRAGMA foreign_keys`).toEqual([
        { foreign_keys: 1n },
      ]);
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      const applied = await prisma.$queryRaw<
        { migration_name: string; checksum: string }[]
      >`SELECT migration_name, checksum FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
      expect(applied.map((row) => row.migration_name)).toEqual([
        ...historicalMigrations,
        ...policyMigrations,
      ]);
      expect(applied).toHaveLength(72);
      expect(policyMigrations).toContain(CANONICAL_RETENTION_MIGRATION);
      for (const row of applied)
        expect(row.checksum).toBe(
          createHash("sha256")
            .update(
              readFileSync(
                join(committed, row.migration_name, "migration.sql"),
              ),
            )
            .digest("hex"),
        );
    } finally {
      await prisma.$disconnect();
    }
  };
  it.each(["dead-claims", "pre-existing-orphans"] as const)(
    "repairs pre-policy %s and orphan hashes/released refs/empty evidence while retaining protected originals and finance",
    verifyPolicyUpgrade,
    60_000,
  );
});
