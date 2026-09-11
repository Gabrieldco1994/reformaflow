require('../../../../scripts/test-db-env.cjs');

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const root = resolve(__dirname, '../../../..');
const migration = '20260911153000_inline_import_expense_creations';

it('upgrades the SAME legacy database after a restorable backup, without inline backfill', async () => {
  const directory = join(root, 'prisma', `test-inline-upgrade-${randomUUID()}`);
  let owned = false;
  let db: PrismaClient | undefined;
  try {
    mkdirSync(directory); // EEXIST never grants ownership to cleanup.
    owned = true;
    const file = join(directory, 'test-inline-upgrade.db');
    const backup = join(directory, 'legacy-backup.db');
    const url = `file:${file}`;
    const guard = require('../../../../scripts/test-db-env.cjs');
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    cpSync(join(root, 'prisma/migrations/migration_lock.toml'), join(migrations, 'migration_lock.toml'));
    for (const name of readdirSync(join(root, 'prisma/migrations')).sort()) {
      if (name < migration && /^\d/.test(name)) cpSync(join(root, 'prisma/migrations', name), join(migrations, name), { recursive: true });
    }
    const schema = join(directory, 'schema.prisma');
    writeFileSync(schema, readFileSync(join(root, 'prisma/schema.prisma'), 'utf8'));
    const deploy = () => execFileSync(process.execPath, [
      require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema,
    ], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    deploy();
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$executeRawUnsafe('PRAGMA foreign_keys=ON');
    await db.tenant.create({ data: { id: 'upgrade-690-tenant', name: 'Synthetic legacy' } });
    await db.project.create({ data: { id: 'upgrade-690-project', tenantId: 'upgrade-690-tenant', type: 'PESSOAL', name: 'Legacy Pessoal' } });
    await db.bankAccount.create({ data: {
      id: 'upgrade-690-account', tenantId: 'upgrade-690-tenant', projectId: 'upgrade-690-project',
      nickname: 'Legacy account', institution: 'ITAU', last4: '0690',
    } });
    // Generated client knows the NEW column, so seed the pre-schema import using explicit columns.
    await db.$executeRawUnsafe(`INSERT INTO bank_statement_imports
      (id, account_id, tenant_id, period_label, source, inserted, total_amount_cents, updated_at)
      VALUES ('upgrade-690-import', 'upgrade-690-account', 'upgrade-690-tenant', '2026-08', 'OFX', 1, 12345, 1)`);
    await db.expense.create({ data: {
      id: 'upgrade-690-expense', tenantId: 'upgrade-690-tenant', projectId: 'upgrade-690-project',
      tipoDespesa: 'OUTROS', valor: 12345, valorTotal: 12345, formaPagamento: 'A_VISTA', status: 'PAGO',
      bankLast4: '0690', importId: 'upgrade-690-import', externalId: 'legacy',
    } });
    const before = await db.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM bank_statement_imports');
    const beforeExpenses = await db.expense.findMany();
    await db.$disconnect();
    execFileSync('sqlite3', [file, `.backup '${backup}'`], { stdio: 'pipe' });
    cpSync(join(root, 'prisma/migrations', migration), join(migrations, migration), { recursive: true });
    deploy();
    await db.$connect();
    const after = await db.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM bank_statement_imports');
    expect(after).toEqual(before.map(row => ({ ...row, inline_expense_creations: null })));
    expect(await db.expense.findMany()).toEqual(beforeExpenses);
    expect(await db.rateioAllocation.count()).toBe(0);
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    expect(execFileSync('sqlite3', [backup, "SELECT count(*) FROM pragma_table_info('bank_statement_imports') WHERE name='inline_expense_creations'"], { encoding: 'utf8' }).trim()).toBe('0');
    expect(execFileSync('sqlite3', [backup, 'SELECT count(*) FROM expenses'], { encoding: 'utf8' }).trim()).toBe('1');
    expect(execFileSync('sqlite3', [backup, 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim()).toBe('ok');
  } finally {
    await db?.$disconnect();
    if (owned && realpathSync(directory) === directory) rmSync(directory, { recursive: true });
  }
}, 30000);
