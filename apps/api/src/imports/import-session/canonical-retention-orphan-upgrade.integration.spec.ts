import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { ProjectType } from "@reformaflow/domain";

type TestDbGuard = {
  REPO_ROOT: string;
  forbiddenReason(url: string): string | null;
  resolveSqlitePath(url: string): string | null;
  resolveRealSqlitePath(url: string): string | null;
};

// The required Jest guard is loaded before this suite accesses a Prisma client.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbGuard =
  require("../../../../../scripts/test-db-env.cjs") as TestDbGuard;
const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");
const CANONICAL_RETENTION_MIGRATION =
  "20261009193000_canonical_import_linkage_retention";
const RETIREMENT_MIGRATION = "20261010100000_retire_unlinked_import_artifacts";

async function insertHistoricalDraftSession(
  client: PrismaClient,
  input: {
    tenantId: string;
    ownerUserId: string;
    ownerProjectId: string;
    cardId: string;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  const now = new Date();
  const kind = "CREATE_CARD_PURCHASES";
  const state = "DRAFT";
  const revision = 1;
  const consentPolicyVersion = 1;
  const createRequestId = randomUUID();
  const createPayloadHash = "a".repeat(64);
  const expiresAt = new Date(now.getTime() + 60_000);
  const draftJson = JSON.stringify({
    scope: { observationIds: [], pendingAttachmentIds: [] },
    lines: [],
  });
  await client.$executeRaw`
    INSERT INTO import_sessions (
      id, tenant_id, owner_user_id, owner_project_id, card_id, kind, state,
      revision, create_request_id, create_payload_hash,
      consent_policy_version, consented_at, updated_at, last_user_edit_at,
      expires_at, draft_json
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.ownerUserId}, ${input.ownerProjectId},
      ${input.cardId}, ${kind}, ${state}, ${revision}, ${createRequestId},
      ${createPayloadHash}, ${consentPolicyVersion}, ${now}, ${now}, ${now},
      ${expiresAt}, ${draftJson}
    )`;
  return { id };
}

async function readHistoricalSession(
  client: PrismaClient,
  id: string,
): Promise<Record<string, unknown>> {
  const rows = await client.$queryRaw<Record<string, unknown>[]>`
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

describe("unlinked import artifact migration repair", () => {
  let workDir: string | null = null;
  let databaseFile: string | null = null;
  let client: PrismaClient | null = null;
  let ownsWorkDir = false;
  let repairCompleted = false;

  function checkedUrl(file: string): string {
    const url = `file:${file}`;
    expect(dbGuard.REPO_ROOT).toBe(REPO_ROOT);
    expect(dbGuard.forbiddenReason(url)).toBeNull();
    expect(dbGuard.resolveSqlitePath(url)).toBe(file);
    expect(dbGuard.resolveRealSqlitePath(url)).toBe(file);
    expect(path.basename(file).toLowerCase()).not.toBe("dev.db");
    return url;
  }

  function deploy(url: string, schema: string): void {
    execFileSync(
      process.execPath,
      [
        require.resolve("prisma/build/index.js"),
        "migrate",
        "deploy",
        "--schema",
        schema,
      ],
      {
        cwd: path.join(REPO_ROOT, "apps", "api"),
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
      },
    );
  }

  beforeAll(async () => {
    const allMigrations = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(
        (name) =>
          /^\d/.test(name) &&
          fs.statSync(path.join(MIGRATIONS_DIR, name)).isDirectory(),
      )
      .sort();
    const retirementIndex = allMigrations.indexOf(RETIREMENT_MIGRATION);
    expect(retirementIndex).toBe(71);
    expect(allMigrations[retirementIndex - 1]).toBe(
      CANONICAL_RETENTION_MIGRATION,
    );
    const installedMigrations = allMigrations.slice(0, retirementIndex);

    workDir = fs.mkdtempSync(
      path.join(REPO_ROOT, "prisma", ".tmp-canonical-orphan-upgrade-"),
    );
    ownsWorkDir = true;
    const migrationsRoot = path.join(workDir, "migrations");
    fs.mkdirSync(migrationsRoot);
    fs.copyFileSync(
      path.join(MIGRATIONS_DIR, "migration_lock.toml"),
      path.join(migrationsRoot, "migration_lock.toml"),
    );
    const schema = path.join(workDir, "schema.prisma");
    fs.copyFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), schema);
    for (const name of installedMigrations) {
      fs.cpSync(
        path.join(MIGRATIONS_DIR, name),
        path.join(migrationsRoot, name),
        { recursive: true },
      );
    }

    databaseFile = path.join(workDir, "orphan-retention.test.db");
    const url = checkedUrl(databaseFile);
    deploy(url, schema);
    client = new PrismaClient({ datasources: { db: { url } } });
    await client.$connect();

    const tenant = await client.tenant.create({
      data: { name: "orphan repair fixture" },
    });
    const project = await client.project.create({
      data: {
        tenantId: tenant.id,
        name: "orphan repair fixture",
        type: ProjectType.PESSOAL,
      },
    });
    const user = await client.user.create({
      data: {
        tenantId: tenant.id,
        username: randomUUID(),
        name: "orphan repair fixture",
        role: "ADMIN",
      },
    });
    const card = await client.creditCard.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        nickname: "orphan repair fixture",
        institution: "orphan repair fixture",
        last4: "4321",
        closingDay: 5,
        dueDay: 10,
      },
    });

    const createSession = async () =>
      insertHistoricalDraftSession(client!, {
        tenantId: tenant.id,
        ownerUserId: user.id,
        ownerProjectId: project.id,
        cardId: card.id,
      });
    const createArtifact = async (
      hashSeed: string,
      storageKey: string | null,
      extractionJson: string | null,
    ) =>
      client!.importArtifact.create({
        data: {
          tenantId: tenant.id,
          ownerProjectId: project.id,
          documentSha256: randomUUID()
            .replaceAll("-", "")
            .padEnd(64, hashSeed)
            .slice(0, 64),
          verifiedBytes: 1,
          detectedFormat: "CSV",
          state: "EXTRACTED",
          storageKey,
          extractionJson,
          parserVersion: "card-local-text-v1",
        },
      });
    const attach = async (
      artifactId: string,
      state: "ATTACHED" | "RELEASED",
    ) => {
      const session = await createSession();
      const now = new Date();
      return client!.importSessionArtifact.create({
        data: {
          tenantId: tenant.id,
          ownerProjectId: project.id,
          sessionId: session.id,
          artifactId,
          position: 0,
          fileName: state === "RELEASED" ? "document" : "fixture.csv",
          declaredMime: "text/csv",
          declaredBytes: 1,
          reservedBytes: 0,
          state,
          verifiedAt: now,
          releasedAt: state === "RELEASED" ? now : null,
        },
      });
    };
    const addUnclaimedObservation = async (
      artifactId: string,
      reference: string,
    ) =>
      client!.importObservation.create({
        data: {
          tenantId: tenant.id,
          ownerProjectId: project.id,
          artifactId,
          reference,
          evidenceJson: "{}",
        },
      });

    const deadExpense = await client.expense.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: 4100,
        quantidade: 1,
        valorTotal: 4100,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        titulo: "Financial tombstone remains",
      },
    });
    const deadClaimArtifact = await createArtifact(
      "b",
      "objects/dead-canonical",
      '{"retained":"must be removed"}',
    );
    const deadClaim = await client.importObservation.create({
      data: {
        tenantId: tenant.id,
        ownerProjectId: project.id,
        artifactId: deadClaimArtifact.id,
        reference: "dead-canonical",
        evidenceJson: "{}",
        canonicalProjectId: project.id,
        canonicalExpenseId: deadExpense.id,
        claimReceiptJson: "{}",
        claimedAt: new Date(),
      },
    });
    const deadClaimRef = await attach(deadClaimArtifact.id, "RELEASED");
    await client.$executeRaw`DROP TRIGGER "expenses_dispose_import_claims_on_soft_delete"`;
    await client.$executeRaw`
      UPDATE expenses SET deleted_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ${tenant.id} AND project_id = ${project.id} AND id = ${deadExpense.id}
    `;

    const storageLessOrphan = await createArtifact("c", null, "{}");
    const storageLessObservation = await addUnclaimedObservation(
      storageLessOrphan.id,
      "empty-storage-less",
    );
    const storageLessRef = await attach(storageLessOrphan.id, "RELEASED");

    const storageBearingOrphan = await createArtifact(
      "d",
      "objects/empty-unclaimed",
      "{}",
    );
    const storageBearingObservation = await addUnclaimedObservation(
      storageBearingOrphan.id,
      "empty-storage-bearing",
    );
    const storageBearingRef = await attach(storageBearingOrphan.id, "RELEASED");

    const sharedArtifact = await createArtifact(
      "e",
      "objects/active-shared",
      '{"shared":"kept for active consent"}',
    );
    const sharedObservation = await addUnclaimedObservation(
      sharedArtifact.id,
      "active-shared",
    );
    const activeSharedRef = await attach(sharedArtifact.id, "ATTACHED");
    const releasedSharedRef = await attach(sharedArtifact.id, "RELEASED");

    const liveReceipt = await client.receipt.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        valor: 500,
        data: new Date(),
        tipo: "PAGAMENTO",
        status: "PREVISTO",
      },
    });
    const claimedPurging = await createArtifact(
      "f",
      "objects/claimed-purging",
      '{"claim":"keep"}',
    );
    const liveObservation = await client.importObservation.create({
      data: {
        tenantId: tenant.id,
        ownerProjectId: project.id,
        artifactId: claimedPurging.id,
        reference: "claimed-purging",
        evidenceJson: "{}",
        canonicalProjectId: project.id,
        canonicalReceiptId: liveReceipt.id,
        claimReceiptJson: '{"receipt":"keep"}',
        claimedAt: new Date(),
      },
    });
    const applied = await createSession();
    const appliedState = "APPLIED";
    const financialRequestId = randomUUID();
    const confirmedRevision = 1;
    const confirmedSessionVersion = 0;
    const confirmedAt = new Date();
    const proposalHash = "b".repeat(64);
    const closedAt = new Date();
    const receiptJson = '{"receipt":"durable"}';
    await client.$executeRaw`
      UPDATE import_sessions
      SET state = ${appliedState},
          financial_request_id = ${financialRequestId},
          confirmed_revision = ${confirmedRevision},
          confirmed_session_version = ${confirmedSessionVersion},
          confirmed_at = ${confirmedAt},
          proposal_hash = ${proposalHash},
          closed_at = ${closedAt},
          receipt_json = ${receiptJson}
      WHERE id = ${applied.id}`;
    const appliedBefore = await readHistoricalSession(client, applied.id);
    await client.importArtifact.update({
      where: { id: claimedPurging.id },
      data: { state: "PURGING" },
    });
    const claimedPurgingBefore = await client.importArtifact.findUniqueOrThrow({
      where: { id: claimedPurging.id },
    });
    const unclaimedPurging = await createArtifact(
      "a",
      "objects/unclaimed-purging",
      '{"private":"erase"}',
    );
    await addUnclaimedObservation(unclaimedPurging.id, "unclaimed-purging");
    await attach(unclaimedPurging.id, "ATTACHED");
    await client.importArtifact.update({
      where: { id: unclaimedPurging.id },
      data: { state: "PURGING" },
    });

    const expectedDeadExpense = await client.expense.findUniqueOrThrow({
      where: { id: deadExpense.id },
    });
    const appliedMigrationsBefore = await client.$queryRaw<
      Array<{ migration_name: string }>
    >`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`;
    expect(
      appliedMigrationsBefore.map(({ migration_name }) => migration_name),
    ).toEqual(installedMigrations);
    await client.$disconnect();
    client = null;

    fs.cpSync(
      path.join(MIGRATIONS_DIR, RETIREMENT_MIGRATION),
      path.join(migrationsRoot, RETIREMENT_MIGRATION),
      { recursive: true },
    );
    deploy(url, schema);
    client = new PrismaClient({ datasources: { db: { url } } });
    await client.$connect();
    const actual = {
      deadExpense: await client.expense.findUniqueOrThrow({
        where: { id: deadExpense.id },
      }),
      deadObservation: await client.importObservation.findUnique({
        where: { id: deadClaim.id },
      }),
      deadArtifact: await client.importArtifact.findUnique({
        where: { id: deadClaimArtifact.id },
      }),
      deadReference: await client.importSessionArtifact.findUnique({
        where: { id: deadClaimRef.id },
      }),
      storageLessObservation: await client.importObservation.findUnique({
        where: { id: storageLessObservation.id },
      }),
      storageLessArtifact: await client.importArtifact.findUnique({
        where: { id: storageLessOrphan.id },
      }),
      storageLessReference: await client.importSessionArtifact.findUnique({
        where: { id: storageLessRef.id },
      }),
      storageBearingObservation: await client.importObservation.findUnique({
        where: { id: storageBearingObservation.id },
      }),
      storageBearingArtifact: await client.importArtifact.findUnique({
        where: { id: storageBearingOrphan.id },
      }),
      storageBearingReference: await client.importSessionArtifact.findUnique({
        where: { id: storageBearingRef.id },
      }),
      sharedObservation: await client.importObservation.findUnique({
        where: { id: sharedObservation.id },
      }),
      sharedArtifactAfterRepair: await client.importArtifact.findUnique({
        where: { id: sharedArtifact.id },
      }),
      activeSharedReference: await client.importSessionArtifact.findUnique({
        where: { id: activeSharedRef.id },
      }),
      releasedSharedReference: await client.importSessionArtifact.findUnique({
        where: { id: releasedSharedRef.id },
      }),
      foreignKeys: await client.$queryRaw`PRAGMA foreign_key_check`,
    };
    expect({
      deadExpense: {
        deletedAt: actual.deadExpense.deletedAt,
        valorTotal: actual.deadExpense.valorTotal,
      },
      deadObservation: actual.deadObservation,
      deadArtifact: actual.deadArtifact && {
        documentSha256: actual.deadArtifact.documentSha256,
        state: actual.deadArtifact.state,
        storageKey: actual.deadArtifact.storageKey,
        extractionJson: actual.deadArtifact.extractionJson,
      },
      deadReference: actual.deadReference,
      storageLessObservation: actual.storageLessObservation,
      storageLessArtifact: actual.storageLessArtifact,
      storageLessReference: actual.storageLessReference,
      storageBearingObservation: actual.storageBearingObservation,
      storageBearingArtifact: actual.storageBearingArtifact && {
        documentSha256: actual.storageBearingArtifact.documentSha256,
        state: actual.storageBearingArtifact.state,
        storageKey: actual.storageBearingArtifact.storageKey,
        extractionJson: actual.storageBearingArtifact.extractionJson,
      },
      storageBearingReference: actual.storageBearingReference,
      sharedObservation: actual.sharedObservation,
      sharedArtifact: actual.sharedArtifactAfterRepair && {
        documentSha256: actual.sharedArtifactAfterRepair.documentSha256,
        state: actual.sharedArtifactAfterRepair.state,
        storageKey: actual.sharedArtifactAfterRepair.storageKey,
        extractionJson: actual.sharedArtifactAfterRepair.extractionJson,
      },
      activeSharedReference: actual.activeSharedReference?.state,
      releasedSharedReference: actual.releasedSharedReference?.state,
      foreignKeys: actual.foreignKeys,
    }).toEqual({
      deadExpense: {
        deletedAt: expect.any(Date),
        valorTotal: 4100,
      },
      deadObservation: null,
      deadArtifact: {
        documentSha256: null,
        state: "PURGING",
        storageKey: "objects/dead-canonical",
        extractionJson: null,
      },
      deadReference: null,
      storageLessObservation: null,
      storageLessArtifact: null,
      storageLessReference: null,
      storageBearingObservation: null,
      storageBearingArtifact: {
        documentSha256: null,
        state: "PURGING",
        storageKey: "objects/empty-unclaimed",
        extractionJson: null,
      },
      storageBearingReference: null,
      sharedObservation,
      sharedArtifact: {
        documentSha256: sharedArtifact.documentSha256,
        state: "EXTRACTED",
        storageKey: "objects/active-shared",
        extractionJson: '{"shared":"kept for active consent"}',
      },
      activeSharedReference: "ATTACHED",
      releasedSharedReference: "RELEASED",
      foreignKeys: [],
    });
    expect(actual.deadExpense.deletedAt).toEqual(expectedDeadExpense.deletedAt);
    expect(
      await client.importArtifact.findUniqueOrThrow({
        where: { id: claimedPurging.id },
      }),
    ).toEqual(claimedPurgingBefore);
    expect(
      await client.importObservation.findUniqueOrThrow({
        where: { id: liveObservation.id },
      }),
    ).toEqual(liveObservation);
    expect(await readHistoricalSession(client, applied.id)).toEqual(
      appliedBefore,
    );
    expect(
      await client.importArtifact.findUniqueOrThrow({
        where: { id: unclaimedPurging.id },
      }),
    ).toMatchObject({
      documentSha256: null,
      extractionJson: null,
      parserVersion: null,
      state: "PURGING",
      storageKey: "objects/unclaimed-purging",
    });
    expect(
      await client.importObservation.count({
        where: { artifactId: unclaimedPurging.id },
      }),
    ).toBe(0);
    expect(await client.$queryRaw`PRAGMA foreign_keys`).toEqual([
      { foreign_keys: 1n },
    ]);
    expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    const appliedMigrationsAfter = await client.$queryRaw<
      Array<{ migration_name: string }>
    >`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`;
    expect(
      appliedMigrationsAfter.map(({ migration_name }) => migration_name),
    ).toEqual([...installedMigrations, RETIREMENT_MIGRATION]);
    expect(appliedMigrationsAfter).toHaveLength(72);
    repairCompleted = true;
  }, 120_000);

  it("repairs legacy orphan artifacts without disturbing shared active references", () => {
    expect(repairCompleted).toBe(true);
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (ownsWorkDir && workDir) fs.rmSync(workDir, { recursive: true });
  });
});
