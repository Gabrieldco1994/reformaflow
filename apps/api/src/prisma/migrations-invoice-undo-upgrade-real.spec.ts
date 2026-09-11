// PR 1 (degrau) — upgrade legado REAL e drill restaurável de backup.
// O alvo é sempre um SQLite descartável validado por scripts/test-db-env.cjs.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import {
  makeBankAccountService,
  pessoalRequester,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { PrismaService } from "./prisma.service";

type TestDbGuard = {
  REPO_ROOT: string;
  REAL_REPO_ROOT: string;
  forbiddenReason: (url: string) => string | null;
  resolveSqlitePath: (url: string) => string | null;
  resolveRealSqlitePath: (url: string) => string | null;
};

// O setupFile já carregou este mesmo módulo antes do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbGuard = require("../../../../scripts/test-db-env.cjs") as TestDbGuard;

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REAL_MIGRATIONS = path.join(REPO_ROOT, "prisma/migrations");
const REAL_SCHEMA = path.join(REPO_ROOT, "prisma/schema.prisma");
const TARGET_MIGRATION = "20260909120000_imported_invoice_liquidations";

const SAFETY_CHILD = process.env.INVOICE_UNDO_UPGRADE_SAFETY_CHILD === "1";
const SAFETY_RUN = "569up-safety-child";
const RUN = SAFETY_CHILD ? SAFETY_RUN : `569up-${process.pid}`;
const RESOURCE_DIR =
  process.env.INVOICE_UNDO_UPGRADE_RESOURCE_DIR ??
  path.join(REPO_ROOT, "prisma");
const TMP_DIR = path.join(RESOURCE_DIR, `.tmp-${RUN}`);
const TMP_MIGRATIONS = path.join(TMP_DIR, "migrations");
const DB_FILE = path.join(RESOURCE_DIR, `test-${RUN}.db`);
const RESTORE_FILE = path.join(RESOURCE_DIR, `test-${RUN}-restore.db`);
const BACKUP_FILE = `${DB_FILE}.bak`;
const DB_URL = `file:${DB_FILE}`;
const RESTORE_URL = `file:${RESTORE_FILE}`;

const legacy = {
  tenant: "iul-up-real",
  project: "iul-up-real-proj",
  projectB: "iul-up-real-proj-b",
  account: "iul-up-real-account",
  card: "iul-up-real-card",
  importLegacy: "imp-legacy-569",
  importMixed: "imp-mixed-569",
  importM8: "imp-m8-569",
  importAdopted: "imp-adopted-569",
  purchaseLegacy: "exp-legacy-purchase",
  purchaseCross: "exp-cross-purchase",
  purchaseRateioTarget: "exp-rateio-target",
  paymentLegacy: "exp-legacy-payment",
  paymentMixedA: "exp-mixed-payment-a",
  paymentMixedB: "exp-mixed-payment-b",
  paymentM8: "exp-m8-payment",
  paymentManual: "exp-manual-payment",
  paymentAdopted: "exp-adopted-payment",
  entryLegacy: "cfe-legacy",
  entryCross: "cfe-cross",
  entryReceipt: "cfe-receipt",
  receiptPlanned: "receipt-planned",
  receiptImported: "receipt-imported",
};

const REQUESTER = pessoalRequester(legacy.project);

function assertSafeDatabaseUrl(url: string, expectedPath: string): void {
  expect(dbGuard.REPO_ROOT).toBe(REPO_ROOT);
  expect(dbGuard.forbiddenReason(url)).toBeNull();
  expect(dbGuard.resolveSqlitePath(url)).toBe(expectedPath);
  const realPath = dbGuard.resolveRealSqlitePath(url);
  expect(realPath).not.toBeNull();
  expect(path.basename(realPath!).toLowerCase()).not.toBe("dev.db");
  expect(path.relative(dbGuard.REAL_REPO_ROOT, realPath!)).not.toMatch(
    /^(?:\.\.(?:\/|$)|\/)/,
  );
}

function assertSafeHarnessPath(file: string): void {
  assertSafeDatabaseUrl(`file:${file}`, file);
}

async function withExplicitDatabaseUrl<T>(
  url: string,
  create: () => Promise<T>,
): Promise<T> {
  const expected = url === DB_URL ? DB_FILE : RESTORE_FILE;
  assertSafeDatabaseUrl(url, expected);
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    return await create();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

function deploy(url: string): void {
  assertSafeDatabaseUrl(url, url === DB_URL ? DB_FILE : RESTORE_FILE);
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(
    process.execPath,
    [
      prismaCli,
      "migrate",
      "deploy",
      "--schema",
      path.join(TMP_DIR, "schema.prisma"),
    ],
    {
      cwd: path.join(REPO_ROOT, "apps/api"),
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    },
  );
}

async function readTable(
  client: PrismaClient,
  table: string,
  orderBy = "id",
): Promise<Array<Record<string, unknown>>> {
  return client.$queryRawUnsafe(
    `SELECT * FROM "${table}" ORDER BY "${orderBy}"`,
  );
}

async function legacyDataSnapshot(client: PrismaClient) {
  const [
    tenants,
    projects,
    accounts,
    cards,
    imports,
    expenses,
    receipts,
    entries,
    settlements,
    allocations,
  ] = await Promise.all([
    readTable(client, "tenants"),
    readTable(client, "projects"),
    readTable(client, "bank_accounts"),
    readTable(client, "credit_cards"),
    readTable(client, "bank_statement_imports"),
    readTable(client, "expenses"),
    readTable(client, "receipts"),
    readTable(client, "cash_flow_entries"),
    readTable(client, "cross_project_settlements"),
    readTable(client, "rateio_allocations"),
  ]);
  const expensesWithoutAddedColumns = expenses.map((expense) => {
    const {
      invoice_undo_state: _state,
      invoice_undo_parcela_count: _count,
      invoice_undo_due_month: _month,
      invoice_undo_card_id: _card,
      invoice_undo_trail_version: _version,
      ...legacyExpense
    } = expense;
    return legacyExpense;
  });
  return {
    tenants,
    projects,
    accounts,
    cards,
    imports,
    expenses: expensesWithoutAddedColumns,
    receipts,
    entries,
    settlements,
    allocations,
  };
}

async function migratedFinancialSnapshot(client: PrismaClient) {
  return {
    ...(await legacyDataSnapshot(client)),
    ledger: await readTable(client, "imported_invoice_liquidations"),
  };
}

async function seedLegacyData(seed: PrismaClient): Promise<void> {
  const fixed = "'2026-09-01 12:00:00'";
  await seed.$executeRawUnsafe(
    `INSERT INTO tenants (id, name, created_at, updated_at)
     VALUES ('${legacy.tenant}', 'Upgrade Real Tenant', ${fixed}, ${fixed})`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO projects (id, tenant_id, type, name, created_at, updated_at)
     VALUES
       ('${legacy.project}', '${legacy.tenant}', 'PESSOAL', 'Pessoal A', ${fixed}, ${fixed}),
       ('${legacy.projectB}', '${legacy.tenant}', 'PESSOAL', 'Pessoal B', ${fixed}, ${fixed})`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO bank_accounts
       (id, project_id, tenant_id, institution, nickname, last4,
        opening_balance_cents, created_at, updated_at)
     VALUES
       ('${legacy.account}', '${legacy.project}', '${legacy.tenant}', 'ITAU',
        'Conta X', '8700', 0, ${fixed}, ${fixed})`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO credit_cards
       (id, project_id, tenant_id, institution, brand, nickname, last4,
        closing_day, due_day, created_at, updated_at)
     VALUES
       ('${legacy.card}', '${legacy.project}', '${legacy.tenant}', 'OUTROS',
        'Outros', 'Cartao legado', '4700', 20, 1, ${fixed}, ${fixed})`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO bank_statement_imports
       (id, tenant_id, account_id, period_label, source, inserted,
        total_amount_cents, created_at, updated_at)
     VALUES
       ('${legacy.importLegacy}', '${legacy.tenant}', '${legacy.account}',
        '2026-01', 'OFX', 1, 30000, '2026-09-01 12:10:00', '2026-09-01 12:10:00'),
       ('${legacy.importMixed}', '${legacy.tenant}', '${legacy.account}',
        '2026-01', 'OFX', 2, 60000, '2026-09-01 12:20:00', '2026-09-01 12:20:00'),
       ('${legacy.importM8}', '${legacy.tenant}', '${legacy.account}',
        '2026-01', 'OFX', 1, 12000, '2026-09-01 12:30:00', '2026-09-01 12:30:00'),
       ('${legacy.importAdopted}', '${legacy.tenant}', '${legacy.account}',
        '2026-01', 'OFX', 1, 15000, '2026-09-02 12:00:00', '2026-09-02 12:00:00')`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO expenses
       (id, tenant_id, project_id, tipo_despesa, titulo, valor, quantidade,
        valor_total, forma_pagamento, data_pagamento, status, import_id,
        external_id, card_last4, bank_last4, settles_invoice_key,
        created_at, updated_at)
     VALUES
       ('${legacy.purchaseLegacy}', '${legacy.tenant}', '${legacy.project}',
        'OUTROS', 'compra legada', 30000, 1, 30000, 'A_VISTA',
        '2026-01-10 12:00:00', 'PAGO', NULL, NULL, '4700', NULL, NULL,
        ${fixed}, ${fixed}),
       ('${legacy.purchaseCross}', '${legacy.tenant}', '${legacy.projectB}',
        'OUTROS', 'compra cross-project', 20000, 1, 20000, 'A_VISTA',
        '2026-01-11 12:00:00', 'PAGO', NULL, NULL, '4700', NULL, NULL,
        ${fixed}, ${fixed}),
       ('${legacy.purchaseRateioTarget}', '${legacy.tenant}', '${legacy.projectB}',
        'OUTROS', 'alvo rateio', 10000, 1, 10000, 'A_VISTA',
        '2026-01-12 12:00:00', 'PLANEJADO', NULL, NULL, NULL, NULL, NULL,
        ${fixed}, ${fixed}),
       ('${legacy.paymentLegacy}', '${legacy.tenant}', '${legacy.project}',
        'PAGAMENTO_FATURA_CARTAO', 'pgto legado', 30000, 1, 30000, 'A_VISTA',
        '2026-01-25 12:00:00', 'PAGO', '${legacy.importLegacy}', NULL,
        '4700', '8700', NULL, '2026-09-01 12:11:00', '2026-09-01 12:11:00'),
       ('${legacy.paymentMixedA}', '${legacy.tenant}', '${legacy.project}',
        'PAGAMENTO_FATURA_CARTAO', 'pgto misto A', 30000, 1, 30000, 'A_VISTA',
        '2026-01-26 12:00:00', 'PAGO', '${legacy.importMixed}', NULL,
        '4700', '8700', NULL, '2026-09-01 12:21:00', '2026-09-01 12:21:00'),
       ('${legacy.paymentMixedB}', '${legacy.tenant}', '${legacy.project}',
        'PAGAMENTO_FATURA_CARTAO', 'pgto misto B', 30000, 1, 30000, 'A_VISTA',
        '2026-01-27 12:00:00', 'PAGO', '${legacy.importMixed}', NULL,
        '4700', '8700', NULL, '2026-09-01 12:22:00', '2026-09-01 12:22:00'),
       ('${legacy.paymentM8}', '${legacy.tenant}', '${legacy.project}',
        'PAGAMENTO_FATURA_CARTAO', 'pgto sem cartao M8', 12000, 1, 12000, 'A_VISTA',
        '2026-01-28 12:00:00', 'PAGO', '${legacy.importM8}', NULL,
        NULL, '8700', NULL, '2026-09-01 12:31:00', '2026-09-01 12:31:00'),
       ('${legacy.paymentManual}', '${legacy.tenant}', '${legacy.project}',
        'PAGAMENTO_FATURA_CARTAO', 'pgto manual', 20000, 1, 20000, 'A_VISTA',
        '2026-01-29 12:00:00', 'PAGO', NULL, NULL,
        '4700', '8700', '4700:2026-02', ${fixed}, ${fixed}),
       ('${legacy.paymentAdopted}', '${legacy.tenant}', '${legacy.project}',
        'PAGAMENTO_FATURA_CARTAO', 'pgto adotado', 15000, 1, 15000, 'A_VISTA',
        '2026-01-30 12:00:00', 'PAGO', '${legacy.importAdopted}', 'adopted-ext-569',
        '4700', '8700', NULL, '2026-09-01 11:00:00', '2026-09-01 11:00:00')`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO receipts
       (id, project_id, tenant_id, valor, data, tipo, status, descricao,
        import_id, linked_receipt_id, created_at, updated_at)
     VALUES
       ('${legacy.receiptPlanned}', '${legacy.projectB}', '${legacy.tenant}',
        9000, '2026-01-15 12:00:00', 'OUTROS', 'PREVISTO', 'previsto',
        NULL, NULL, ${fixed}, ${fixed}),
       ('${legacy.receiptImported}', '${legacy.project}', '${legacy.tenant}',
        9000, '2026-01-15 12:00:00', 'OUTROS', 'EM_CAIXA', 'importado',
        '${legacy.importLegacy}', '${legacy.receiptPlanned}',
        '2026-09-01 12:12:00', '2026-09-01 12:12:00')`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO cash_flow_entries
       (id, tenant_id, project_id, receipt_id, expense_id, valor, tipo, data,
        categoria, forma_pagamento, status, created_at, updated_at)
     VALUES
       ('${legacy.entryLegacy}', '${legacy.tenant}', '${legacy.project}', NULL,
        '${legacy.purchaseLegacy}', 30000, 'DESPESA', '2026-01-10 12:00:00',
        'OUTROS', 'CARTAO_CREDITO', 'PAGO', ${fixed}, ${fixed}),
       ('${legacy.entryCross}', '${legacy.tenant}', '${legacy.projectB}', NULL,
        '${legacy.purchaseCross}', 20000, 'DESPESA', '2026-01-11 12:00:00',
        'OUTROS', 'CARTAO_CREDITO', 'PAGO', ${fixed}, ${fixed}),
       ('${legacy.entryReceipt}', '${legacy.tenant}', '${legacy.project}',
        '${legacy.receiptImported}', NULL, 9000, 'RECEBIMENTO',
        '2026-01-15 12:00:00', 'OUTROS', 'CONTA_CORRENTE', 'EM_CAIXA',
        ${fixed}, ${fixed})`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO cross_project_settlements
       (id, tenant_id, source_expense_id, target_expense_id, parcela_index,
        real_valor, planned_valor, planned_status, created_at)
     VALUES
       ('upgrade-settlement', '${legacy.tenant}', '${legacy.paymentLegacy}',
        '${legacy.purchaseCross}', 0, 20000, 20000, 'PLANEJADO', ${fixed})`,
  );
  await seed.$executeRawUnsafe(
    `INSERT INTO rateio_allocations
       (id, tenant_id, source_expense_id, target_expense_id, allocation,
        planned_status, created_at)
     VALUES
       ('upgrade-allocation', '${legacy.tenant}', '${legacy.purchaseLegacy}',
        '${legacy.purchaseRateioTarget}', 10000, 'PLANEJADO', ${fixed})`,
  );
}

describe("#569 §6.7 — upgrade legado REAL + restore validado", () => {
  let seed: PrismaClient | undefined;
  let db: PrismaClient;
  let restored: PrismaClient;
  let servicePrisma: PrismaService;
  let bank: ReturnType<typeof makeBankAccountService>;
  let beforeMigration: Awaited<ReturnType<typeof legacyDataSnapshot>>;
  let seedForeignKeys = 0;
  let pathsValidated = false;
  let ownsTmpDir = false;
  let ownsDbFile = false;
  let ownsBackupFile = false;
  let ownsRestoreFile = false;

  beforeAll(async () => {
    // PRIMEIRO ato: validar os dois overrides antes de qualquer FS, CLI ou client.
    assertSafeDatabaseUrl(DB_URL, DB_FILE);
    assertSafeDatabaseUrl(RESTORE_URL, RESTORE_FILE);
    pathsValidated = true;

    fs.mkdirSync(TMP_DIR);
    ownsTmpDir = true;
    fs.mkdirSync(TMP_MIGRATIONS);
    const dbFileHandle = fs.openSync(DB_FILE, "wx");
    ownsDbFile = true;
    fs.closeSync(dbFileHandle);
    fs.copyFileSync(
      path.join(REAL_MIGRATIONS, "migration_lock.toml"),
      path.join(TMP_MIGRATIONS, "migration_lock.toml"),
    );
    fs.copyFileSync(REAL_SCHEMA, path.join(TMP_DIR, "schema.prisma"));

    const orderedMigrations = fs
      .readdirSync(REAL_MIGRATIONS)
      .filter((name) =>
        fs.statSync(path.join(REAL_MIGRATIONS, name)).isDirectory(),
      )
      .sort();
    const targetIndex = orderedMigrations.indexOf(TARGET_MIGRATION);
    expect(targetIndex).toBeGreaterThan(0);
    const legacyMigrations = orderedMigrations.slice(0, targetIndex);
    expect(
      legacyMigrations.at(-1)!.localeCompare(TARGET_MIGRATION),
    ).toBeLessThan(0);
    for (const name of legacyMigrations) {
      fs.cpSync(
        path.join(REAL_MIGRATIONS, name),
        path.join(TMP_MIGRATIONS, name),
        { recursive: true },
      );
    }
    deploy(DB_URL);

    seed = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await seed.$connect();
    await seed.$executeRawUnsafe("PRAGMA foreign_keys = ON");
    const pragma = (await seed.$queryRawUnsafe(
      "PRAGMA foreign_keys",
    )) as Array<{ foreign_keys: bigint }>;
    seedForeignKeys = Number(pragma[0].foreign_keys);
    expect(seedForeignKeys).toBe(1);
    await seedLegacyData(seed);
    beforeMigration = await legacyDataSnapshot(seed);
    await seed.$disconnect();
    seed = undefined;

    fs.copyFileSync(DB_FILE, BACKUP_FILE, fs.constants.COPYFILE_EXCL);
    ownsBackupFile = true;
    fs.copyFileSync(BACKUP_FILE, RESTORE_FILE, fs.constants.COPYFILE_EXCL);
    ownsRestoreFile = true;
    restored = new PrismaClient({
      datasources: { db: { url: RESTORE_URL } },
    });
    await restored.$connect();
    await restored.$executeRawUnsafe("PRAGMA foreign_keys = ON");

    // Completa o diretório com alvo + eventuais migrations FUTURAS, em ordem.
    for (const name of orderedMigrations.slice(targetIndex)) {
      fs.cpSync(
        path.join(REAL_MIGRATIONS, name),
        path.join(TMP_MIGRATIONS, name),
        { recursive: true },
      );
    }
    deploy(DB_URL);

    db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await db.$connect();
    await withExplicitDatabaseUrl(DB_URL, async () => {
      servicePrisma = new PrismaService();
      await servicePrisma.onModuleInit();
    });
    bank = makeBankAccountService(servicePrisma);
  }, 120_000);

  afterAll(async () => {
    const disconnects: Array<Promise<void>> = [];
    if (servicePrisma) disconnects.push(servicePrisma.onModuleDestroy());
    if (db) disconnects.push(db.$disconnect());
    if (restored) disconnects.push(restored.$disconnect());
    if (seed) disconnects.push(seed.$disconnect());
    const disconnectResults = await Promise.allSettled(disconnects);
    const failedDisconnect = disconnectResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (!pathsValidated) {
      if (failedDisconnect) throw failedDisconnect.reason;
      return;
    }

    const ownedPaths = [
      ...(ownsTmpDir ? [TMP_DIR] : []),
      ...(ownsDbFile ? [DB_FILE, `${DB_FILE}-journal`] : []),
      ...(ownsRestoreFile ? [RESTORE_FILE, `${RESTORE_FILE}-journal`] : []),
      ...(ownsBackupFile ? [BACKUP_FILE] : []),
    ];
    for (const file of ownedPaths) assertSafeHarnessPath(file);

    if (ownsTmpDir) fs.rmSync(TMP_DIR, { recursive: true });
    if (ownsDbFile) {
      fs.rmSync(DB_FILE, { force: true });
      fs.rmSync(`${DB_FILE}-journal`, { force: true });
    }
    if (ownsRestoreFile) {
      fs.rmSync(RESTORE_FILE, { force: true });
      fs.rmSync(`${RESTORE_FILE}-journal`, { force: true });
    }
    if (ownsBackupFile) fs.rmSync(BACKUP_FILE, { force: true });
    if (failedDisconnect) throw failedDisconnect.reason;
  });

  it("prova URL/realpath seguros e foreign_keys=1 antes do seed", () => {
    expect(seedForeignKeys).toBe(1);
    assertSafeDatabaseUrl(DB_URL, DB_FILE);
    assertSafeDatabaseUrl(RESTORE_URL, RESTORE_FILE);
    expect(fs.statSync(BACKUP_FILE).size).toBeGreaterThan(0);
    expect(fs.statSync(RESTORE_FILE).size).toBe(fs.statSync(BACKUP_FILE).size);
  });

  (SAFETY_CHILD ? it.skip : it)(
    "hooks reais: symlink externo rejeitado não altera nem remove canários",
    () => {
      const holder = fs.mkdtempSync(
        path.join(REPO_ROOT, "prisma", ".tmp-569-safety-holder-"),
      );
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), "qa-569-upgrade-safety-"),
      );
      const resourceDir = path.join(holder, "redirected-prisma");
      const childTmp = path.join(outside, `.tmp-${SAFETY_RUN}`);
      fs.mkdirSync(childTmp);
      const canaries = [
        path.join(outside, `test-${SAFETY_RUN}.db`),
        path.join(outside, `test-${SAFETY_RUN}-restore.db`),
        path.join(outside, `test-${SAFETY_RUN}.db.bak`),
        path.join(outside, `test-${SAFETY_RUN}.db-journal`),
        path.join(outside, `test-${SAFETY_RUN}-restore.db-journal`),
        path.join(childTmp, "must-survive.txt"),
      ].map((file, index) => {
        const content = Buffer.from(`synthetic harness canary ${index}\n`);
        fs.writeFileSync(file, content, { flag: "wx" });
        return { file, content };
      });
      fs.symlinkSync(outside, resourceDir, "dir");

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        INVOICE_UNDO_UPGRADE_RESOURCE_DIR: resourceDir,
        INVOICE_UNDO_UPGRADE_SAFETY_CHILD: "1",
      };
      delete childEnv.JEST_WORKER_ID;
      const childConfig = JSON.stringify({
        rootDir: path.join(REPO_ROOT, "apps/api/src"),
        testEnvironment: "node",
        transform: { "^.+\\.(t|j)s$": require.resolve("ts-jest") },
        moduleNameMapper: {
          "^@reformaflow/domain/dist/(.*)$": path.join(
            REPO_ROOT,
            "packages/domain/dist/$1",
          ),
          "^@reformaflow/domain(.*)$": path.join(
            REPO_ROOT,
            "packages/domain/src$1",
          ),
        },
      });
      const child = spawnSync(
        process.execPath,
        [
          require.resolve("jest/bin/jest"),
          "--config",
          childConfig,
          "--runInBand",
          "--runTestsByPath",
          __filename,
          "--no-cache",
        ],
        {
          cwd: path.join(REPO_ROOT, "apps/api"),
          env: childEnv,
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      const after = canaries.map(({ file }) =>
        fs.existsSync(file) ? fs.readFileSync(file) : null,
      );
      const outsideEntriesAfter = fs.readdirSync(outside).sort();
      const childTmpEntriesAfter = fs.existsSync(childTmp)
        ? fs.readdirSync(childTmp).sort()
        : null;
      const resourceLinkSurvived = fs.lstatSync(resourceDir).isSymbolicLink();

      fs.unlinkSync(resourceDir);
      for (const { file } of canaries) fs.rmSync(file, { force: true });
      if (fs.existsSync(childTmp)) fs.rmdirSync(childTmp);
      fs.rmdirSync(outside);
      fs.rmdirSync(holder);

      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(1);
      expect(`${child.stdout}\n${child.stderr}`).toContain(
        "escapa do worktree atual por symlink",
      );
      expect(after).toEqual(canaries.map(({ content }) => content));
      expect(outsideEntriesAfter).toEqual([
        `.tmp-${SAFETY_RUN}`,
        `test-${SAFETY_RUN}-restore.db`,
        `test-${SAFETY_RUN}-restore.db-journal`,
        `test-${SAFETY_RUN}.db`,
        `test-${SAFETY_RUN}.db-journal`,
        `test-${SAFETY_RUN}.db.bak`,
      ]);
      expect(childTmpEntriesAfter).toEqual(["must-survive.txt"]);
      expect(resourceLinkSurvived).toBe(true);
    },
    75_000,
  );

  it("drill de restore: backup restaurado abre, passa integrity/FK e preserva snapshot legado completo", async () => {
    const integrity = (await restored.$queryRawUnsafe(
      "PRAGMA integrity_check",
    )) as Array<{ integrity_check: string }>;
    expect(integrity).toEqual([{ integrity_check: "ok" }]);
    expect(await restored.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual(
      [],
    );
    expect(await legacyDataSnapshot(restored)).toEqual(beforeMigration);
  });

  it("migrate deploy no MESMO DB preserva toda a massa legada PESSOAL/cross-project/M8/manual/adotada", async () => {
    const afterMigration = await legacyDataSnapshot(db);
    const legacyImports = afterMigration.imports.map(({ inline_expense_creations, ...legacyImport }) => {
      expect(inline_expense_creations).toBeNull();
      return legacyImport;
    });
    expect({ ...afterMigration, imports: legacyImports }).toEqual(beforeMigration);
    expect(beforeMigration.projects).toHaveLength(2);
    expect(beforeMigration.expenses).toHaveLength(9);
    expect(beforeMigration.receipts).toHaveLength(2);
    expect(beforeMigration.settlements).toHaveLength(1);
    expect(beforeMigration.allocations).toHaveLength(1);
  });

  it("5 colunas invoice_undo_* existem e ficam NULL em TODAS as 9 expenses; ledger nasce vazio", async () => {
    const columns = (await db.$queryRawUnsafe(
      "PRAGMA table_info('expenses')",
    )) as Array<{ name: string }>;
    const undoColumns = columns
      .map((column) => column.name)
      .filter((name) => name.startsWith("invoice_undo_"))
      .sort();
    expect(undoColumns).toEqual([
      "invoice_undo_card_id",
      "invoice_undo_due_month",
      "invoice_undo_parcela_count",
      "invoice_undo_state",
      "invoice_undo_trail_version",
    ]);
    const stamped = (await db.$queryRawUnsafe(
      `SELECT id FROM expenses
       WHERE invoice_undo_state IS NOT NULL
          OR invoice_undo_parcela_count IS NOT NULL
          OR invoice_undo_due_month IS NOT NULL
          OR invoice_undo_card_id IS NOT NULL
          OR invoice_undo_trail_version IS NOT NULL`,
    )) as Array<{ id: string }>;
    expect(stamped).toEqual([]);
    expect(await readTable(db, "imported_invoice_liquidations")).toEqual([]);
  });

  it("FK check limpo e 5 FKs exatas usam as colunas corretas com ON DELETE RESTRICT", async () => {
    expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
    const foreignKeys = (await db.$queryRawUnsafe(
      "PRAGMA foreign_key_list('imported_invoice_liquidations')",
    )) as Array<{
      from: string;
      table: string;
      to: string;
      on_delete: string;
    }>;
    expect(
      foreignKeys
        .map(({ from, table, to, on_delete }) => ({
          from,
          table,
          to,
          on_delete,
        }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    ).toEqual([
      {
        from: "card_id",
        table: "credit_cards",
        to: "id",
        on_delete: "RESTRICT",
      },
      {
        from: "cash_flow_entry_id",
        table: "cash_flow_entries",
        to: "id",
        on_delete: "RESTRICT",
      },
      {
        from: "import_id",
        table: "bank_statement_imports",
        to: "id",
        on_delete: "RESTRICT",
      },
      {
        from: "payment_expense_id",
        table: "expenses",
        to: "id",
        on_delete: "RESTRICT",
      },
      {
        from: "purchase_expense_id",
        table: "expenses",
        to: "id",
        on_delete: "RESTRICT",
      },
    ]);
  });

  it("índice da entry é UNIQUE PARCIAL exato (deleted_at IS NULL)", async () => {
    const indexes = (await db.$queryRawUnsafe(
      "PRAGMA index_list('imported_invoice_liquidations')",
    )) as Array<{ name: string; unique: bigint; partial: bigint }>;
    expect(
      indexes.find(
        (index) =>
          index.name === "imported_invoice_liquidations_entry_active_key",
      ),
    ).toMatchObject({ unique: 1n, partial: 1n });
    const info = (await db.$queryRawUnsafe(
      "PRAGMA index_info('imported_invoice_liquidations_entry_active_key')",
    )) as Array<{ name: string }>;
    expect(info.map((column) => column.name)).toEqual(["cash_flow_entry_id"]);
    const sql = (await db.$queryRawUnsafe(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index'
         AND name = 'imported_invoice_liquidations_entry_active_key'`,
    )) as Array<{ sql: string }>;
    expect(sql).toHaveLength(1);
    expect(sql[0].sql).toMatch(
      /UNIQUE\s+INDEX[\s\S]*cash_flow_entry_id[\s\S]*WHERE\s+"?deleted_at"?\s+IS\s+NULL/i,
    );
  });

  it("REAL PrismaService lê o lote legado no DB migrado e undoImport responde 409 sem uma única escrita", async () => {
    const before = await migratedFinancialSnapshot(db);
    const detail = await bank.getImportDetail(
      legacy.tenant,
      legacy.project,
      legacy.account,
      legacy.importLegacy,
      REQUESTER,
    );
    expect(detail).toMatchObject({
      importId: legacy.importLegacy,
      canUndo: false,
      blockReason: "LEGACY_OR_MIXED",
      alreadyUndone: false,
      blocking: { cardInvoicePayments: 1 },
    });

    let error: unknown;
    try {
      await bank.undoImport(
        legacy.tenant,
        legacy.project,
        legacy.account,
        legacy.importLegacy,
        REQUESTER,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as Error).message).toMatch(/LEGACY_OR_MIXED/);
    expect(await migratedFinancialSnapshot(db)).toEqual(before);
  });
});
