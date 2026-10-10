import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { INCLUDE_SOFT_DELETED, PrismaService } from './prisma.service';

const root = resolve(__dirname, '../../../..');
const migration = '20260929010000_import_session_bootstrap';

it('upgrades the exact 69-migration P01 legacy fixture without financial or historical changes', async () => {
  const guard = require('../../../../scripts/test-db-env.cjs');
  const directory = join(
    root,
    'prisma',
    `test-import-session-upgrade-${randomUUID()}`,
  );
  const previousUrl = process.env.DATABASE_URL;
  let db: PrismaService | undefined;
  mkdirSync(directory);
  try {
    const url = `file:${join(directory, 'test-upgrade.db')}`;
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    cpSync(
      join(root, 'prisma/migrations/migration_lock.toml'),
      join(migrations, 'migration_lock.toml'),
    );
    const legacyNames = readdirSync(join(root, 'prisma/migrations'))
      .filter((name) => /^\d/.test(name) && name < migration)
      .sort();
    expect(legacyNames).toHaveLength(69);
    const digest = (name: string): string =>
      createHash('sha256')
        .update(
          readFileSync(join(root, 'prisma/migrations', name, 'migration.sql')),
        )
        .digest('hex');
    const checksums = legacyNames.map(digest);
    for (const name of legacyNames)
      cpSync(join(root, 'prisma/migrations', name), join(migrations, name), {
        recursive: true,
      });
    const schema = join(directory, 'schema.prisma');
    writeFileSync(schema, readFileSync(join(root, 'prisma/schema.prisma')));
    const deploy = (): void => {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url };
      delete env.NODE_OPTIONS;
      delete env.JEST_WORKER_ID;
      execFileSync(
        process.execPath,
        [
          require.resolve('prisma/build/index.js'),
          'migrate',
          'deploy',
          '--schema',
          schema,
        ],
        { cwd: root, env, stdio: 'pipe' },
      );
    };
    deploy();
    process.env.DATABASE_URL = url;
    db = new PrismaService();
    await db.$connect();
    await db.$executeRaw`PRAGMA foreign_keys=ON`;
    await db.tenant.create({
      data: { id: 'legacy-tenant', name: 'Synthetic legacy' },
    });
    await db.project.create({
      data: {
        id: 'legacy-project',
        tenantId: 'legacy-tenant',
        name: 'Synthetic legacy',
        type: 'PESSOAL',
      },
    });
    await db.user.create({
      data: {
        id: 'legacy-user',
        tenantId: 'legacy-tenant',
        username: 'legacy',
        name: 'Synthetic actor',
      },
    });
    await db.creditCard.create({
      data: {
        id: 'legacy-card',
        tenantId: 'legacy-tenant',
        projectId: 'legacy-project',
        institution: 'OUTROS',
        nickname: 'Synthetic legacy',
        last4: '1234',
      },
    });
    // Historical fixture, not a demo seeder: preserve explicit financial rows before upgrade.
    // Raw SQL on purpose: the legacy DB has 69 migrations and the current
    // Prisma client also writes columns added by later migrations.
    await db.$executeRaw`INSERT INTO expenses
      (id, tenant_id, project_id, tipo_despesa, valor, quantidade, valor_total, forma_pagamento,
       status, bank_last4, data_pagamento, updated_at)
      VALUES ('legacy-expense', 'legacy-tenant', 'legacy-project', 'OUTROS', 69840, 1, 69840,
        'A_VISTA', 'PAGO', '4321', ${new Date('2026-09-01T00:00:00.000Z').getTime()}, 1)`;
    await db.receipt.create({
      data: {
        id: 'legacy-receipt',
        tenantId: 'legacy-tenant',
        projectId: 'legacy-project',
        valor: 100000,
        data: new Date('2026-09-01T00:00:00.000Z'),
        tipo: 'PAGAMENTO',
        status: 'EM_CAIXA',
        bankLast4: '4321',
      },
    });
    const date = new Date('2026-09-01T00:00:00.000Z');
    await db.cashFlowEntry.create({
      data: {
        id: 'legacy-expense-cfe',
        tenantId: 'legacy-tenant',
        projectId: 'legacy-project',
        expenseId: 'legacy-expense',
        valor: -69840,
        tipo: 'DESPESA',
        data: date,
        categoria: 'OUTROS',
        status: 'PAGO',
      },
    });
    await db.cashFlowEntry.create({
      data: {
        id: 'legacy-receipt-cfe',
        tenantId: 'legacy-tenant',
        projectId: 'legacy-project',
        receiptId: 'legacy-receipt',
        valor: 100000,
        tipo: 'RECEBIMENTO',
        data: date,
        categoria: 'PAGAMENTO',
        status: 'EM_CAIXA',
      },
    });
    // Each parent also has pre-existing soft-deleted history in a different tenant.
    await db.tenant.create({
      data: { id: 'historical-tenant', name: 'Historical fixture' },
    });
    await db.project.create({
      data: {
        id: 'historical-project',
        tenantId: 'historical-tenant',
        name: 'Historical',
        deletedAt: date,
      },
    });
    await db.user.create({
      data: {
        id: 'historical-user',
        tenantId: 'historical-tenant',
        username: 'historical',
        name: 'Historical',
        deletedAt: date,
      },
    });
    await db.creditCard.create({
      data: {
        id: 'historical-card',
        tenantId: 'historical-tenant',
        projectId: 'historical-project',
        institution: 'OUTROS',
        nickname: 'Historical',
        last4: '1234',
        deletedAt: date,
      },
    });
    await db.$executeRaw`INSERT INTO expenses
      (id, tenant_id, project_id, tipo_despesa, valor, valor_total, forma_pagamento,
       status, deleted_at, updated_at)
      VALUES ('historical-expense', 'historical-tenant', 'historical-project', 'OUTROS', 1, 1,
        'A_VISTA', 'PAGO', ${date.getTime()}, 1)`;
    await db.receipt.create({
      data: {
        id: 'historical-receipt',
        tenantId: 'historical-tenant',
        projectId: 'historical-project',
        valor: 1,
        data: date,
        tipo: 'OUTROS',
        deletedAt: date,
      },
    });
    const parentWhere = {
      tenantId: { in: ['legacy-tenant', 'historical-tenant'] },
      deletedAt: INCLUDE_SOFT_DELETED,
    };
    const snapshot = async (): Promise<unknown> => ({
      users: await db!.user.findMany({
        where: parentWhere,
        orderBy: { id: 'asc' },
      }),
      projects: await db!.project.findMany({
        where: parentWhere,
        orderBy: { id: 'asc' },
      }),
      cards: await db!.creditCard.findMany({
        where: parentWhere,
        orderBy: { id: 'asc' },
      }),
      expenses: await db!.$queryRaw`SELECT * FROM expenses
        WHERE tenant_id IN ('legacy-tenant', 'historical-tenant') ORDER BY id`,
      receipts: await db!.receipt.findMany({
        where: parentWhere,
        orderBy: { id: 'asc' },
      }),
      cfes: await db!.cashFlowEntry.findMany({
        where: parentWhere,
        orderBy: { id: 'asc' },
      }),
      cash: await db!.$queryRaw`SELECT
        (SELECT SUM(valor) FROM receipts WHERE tenant_id='legacy-tenant' AND bank_last4 IS NOT NULL AND status='EM_CAIXA' AND deleted_at IS NULL)
        - (SELECT SUM(valor_total) FROM expenses WHERE tenant_id='legacy-tenant' AND bank_last4 IS NOT NULL AND status='PAGO' AND deleted_at IS NULL) AS balance`,
    });
    const before = await snapshot();
    expect(before).toMatchObject({ cash: [{ balance: 30160n }] });
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    const legacyStructure = await db.$queryRaw`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;
    await db.$disconnect();
    cpSync(
      join(directory, 'test-upgrade.db'),
      join(directory, 'legacy-backup.db'),
    );
    cpSync(
      join(root, 'prisma/migrations', migration),
      join(migrations, migration),
      { recursive: true },
    );
    deploy();
    await db.$connect();
    expect(await snapshot()).toEqual(before);
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    expect(
      await db.$queryRaw`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND tbl_name NOT IN ('import_sessions','import_artifacts','import_session_artifacts','import_observations')
        AND name NOT IN ('users_tenant_id_id_key','projects_tenant_id_id_key',
          'credit_cards_tenant_id_project_id_id_key','expenses_tenant_id_project_id_id_key','receipts_tenant_id_project_id_id_key')
      ORDER BY type, name`,
    ).toEqual(legacyStructure);
    const history = await db.$queryRaw<
      Array<{ migration_name: string; checksum: string }>
    >`SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY migration_name`;
    expect(history).toHaveLength(70);
    expect(history.slice(0, 69).map((row) => row.checksum)).toEqual(checksums);
    expect(legacyNames.map(digest)).toEqual(checksums);
    expect(
      await db.$queryRaw`SELECT
      (SELECT COUNT(*) FROM import_sessions) +
      (SELECT COUNT(*) FROM import_artifacts) +
      (SELECT COUNT(*) FROM import_session_artifacts) +
      (SELECT COUNT(*) FROM import_observations) AS count`,
    ).toEqual([{ count: 0n }]);
    deploy(); // deploy is idempotent on the already-upgraded database.
    expect(await snapshot()).toEqual(before);
  } finally {
    await db?.$disconnect();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
