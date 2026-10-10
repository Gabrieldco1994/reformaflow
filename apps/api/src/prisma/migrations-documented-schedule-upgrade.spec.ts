require('../../../../scripts/test-db-env.cjs');

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaService } from './prisma.service';
import {
  parseStoredExpenseSchedule,
  serializeFinancialScheduleResponse,
} from '../expense/documented-schedule';
import { DocumentedScheduleService } from '../credit-card/documented-schedule.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

const root = resolve(__dirname, '../../../..');
const migration = '20260923210000_documented_expense_schedule';

it('adds nullable columns to the same legacy DB without changing money, snapshots or middleware', async () => {
  const directory = join(
    root,
    'prisma',
    `test-schedule-upgrade-${randomUUID()}`,
  );
  const previousUrl = process.env.DATABASE_URL;
  let owned = false;
  let db: PrismaService | undefined;
  try {
    mkdirSync(directory);
    owned = true;
    const file = join(directory, 'test-schedule-upgrade.db');
    const backup = join(directory, 'legacy-backup.db');
    const url = `file:${file}`;
    const guard = require('../../../../scripts/test-db-env.cjs');
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    cpSync(
      join(root, 'prisma/migrations/migration_lock.toml'),
      join(migrations, 'migration_lock.toml'),
    );
    for (const name of readdirSync(join(root, 'prisma/migrations')).sort()) {
      if (/^\d/.test(name) && name < migration) {
        cpSync(join(root, 'prisma/migrations', name), join(migrations, name), {
          recursive: true,
        });
      }
    }
    const schema = join(directory, 'schema.prisma');
    writeFileSync(
      schema,
      readFileSync(join(root, 'prisma/schema.prisma'), 'utf8'),
    );
    const deploy = () =>
      execFileSync(
        process.execPath,
        [
          require.resolve('prisma/build/index.js'),
          'migrate',
          'deploy',
          '--schema',
          schema,
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: url },
          stdio: 'pipe',
        },
      );
    deploy();
    process.env.DATABASE_URL = url;
    db = new PrismaService();
    await db.$executeRaw`PRAGMA foreign_keys=ON`;
    await db.tenant.create({
      data: { id: 'schedule-upgrade-tenant', name: 'Synthetic legacy' },
    });
    await db.project.create({
      data: {
        id: 'schedule-upgrade-project',
        tenantId: 'schedule-upgrade-tenant',
        type: 'PESSOAL',
        name: 'Synthetic legacy project',
      },
    });
    await db.project.create({
      data: {
        id: 'schedule-upgrade-target',
        tenantId: 'schedule-upgrade-tenant',
        type: 'REFORMA',
        name: 'Synthetic legacy target',
      },
    });
    await db.user.create({
      data: {
        id: 'legacy-actor',
        tenantId: 'schedule-upgrade-tenant',
        username: 'legacy-actor',
        name: 'Synthetic operator',
        role: 'OWNER',
        allowedProjects:
          '["schedule-upgrade-project","schedule-upgrade-target"]',
        allowedModules: '["expenses","creditCards"]',
        allowedProjectTypes: '["PESSOAL","REFORMA"]',
      },
    });
    await db.creditCard.create({
      data: {
        id: 'legacy-card',
        tenantId: 'schedule-upgrade-tenant',
        projectId: 'schedule-upgrade-project',
        institution: 'OUTROS',
        nickname: 'Synthetic legacy',
        last4: '1701',
      },
    });
    await db.creditCardStatementImport.create({
      data: {
        id: 'legacy-import',
        tenantId: 'schedule-upgrade-tenant',
        cardId: 'legacy-card',
        fileName: 'synthetic.csv',
        periodLabel: '2026-08',
        status: 'COMPLETED',
        inserted: 1,
        skipped: 0,
        source: 'CSV_GENERIC',
      },
    });
    // Explicit legacy columns avoid asking the generated client for fields not yet migrated.
    for (const id of ['source', 'target', 'manual']) {
      const project =
        id === 'target'
          ? 'schedule-upgrade-target'
          : 'schedule-upgrade-project';
      await db.$executeRaw`INSERT INTO expenses
        (id, tenant_id, project_id, tipo_despesa, valor, quantidade, valor_total,
         forma_pagamento, status, installment_date_overrides, updated_at)
        VALUES (${id}, 'schedule-upgrade-tenant', ${project}, 'OUTROS',
          12345, 1, 12345, 'A_VISTA', 'PLANEJADO', '{"0":"2026-08-31"}', 1)`;
    }
    await db.$executeRaw`UPDATE expenses SET import_id='legacy-import', external_id='legacy-external-id',
      card_last4='1701', origin='CSV_GENERIC', linked_expense_id='target' WHERE id='source'`;
    await db.$executeRaw`UPDATE expenses SET card_last4='1701' WHERE id='manual'`;
    await db.$executeRaw`INSERT INTO cash_flow_entries
      (id, tenant_id, project_id, expense_id, valor, tipo, data, categoria, status, updated_at)
      VALUES ('manual-entry', 'schedule-upgrade-tenant', 'schedule-upgrade-project', 'manual',
        12345, 'DESPESA', 1788134400000, 'OUTROS', 'PLANEJADO', 1)`;
    await db.$executeRaw`INSERT INTO cash_flow_entries
      (id, tenant_id, project_id, expense_id, valor, tipo, data, categoria, status, parcela, updated_at)
      VALUES ('entry', 'schedule-upgrade-tenant', 'schedule-upgrade-project', 'source',
        12345, 'DESPESA', 1788134400000, 'OUTROS', 'PLANEJADO', '2/3', 1)`;
    await db.$executeRaw`INSERT INTO cash_flow_entries
      (id, tenant_id, project_id, expense_id, valor, tipo, data, categoria, status, updated_at)
      VALUES ('target-entry', 'schedule-upgrade-tenant', 'schedule-upgrade-target', 'target',
        12345, 'DESPESA', 1788134400000, 'OUTROS', 'PLANEJADO', 1)`;
    await db.$executeRaw`INSERT INTO rateio_allocations
      (id, tenant_id, source_expense_id, target_expense_id, allocation, planned_status,
       planned_paid, planned_valor, planned_quantidade, planned_valor_total, planned_forma,
       planned_qtd_parcela, planned_data_inicio, planned_data_pagamento, planned_installment_date_overrides)
      VALUES ('allocation', 'schedule-upgrade-tenant', 'source', 'target', 12345, 'PLANEJADO',
        '[0]', 7000, 2, 14000, 'PARCELADO', 2, 1785542400000, NULL, '{"1":"2026-09-15"}')`;
    const beforeExpenses =
      await db.$queryRaw`SELECT * FROM expenses ORDER BY id`;
    const beforeEntries =
      await db.$queryRaw`SELECT * FROM cash_flow_entries ORDER BY id`;
    const beforeAllocations =
      await db.$queryRaw`SELECT * FROM rateio_allocations ORDER BY id`;
    await db.$disconnect();
    execFileSync('sqlite3', [file, `.backup '${backup}'`], { stdio: 'pipe' });
    cpSync(
      join(root, 'prisma/migrations', migration),
      join(migrations, migration),
      { recursive: true },
    );
    deploy();
    await db.$connect();
    const expensesAfter = await db.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM expenses ORDER BY id`;
    const entriesAfter = await db.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM cash_flow_entries ORDER BY id`;
    const { planned_documented_schedule: plannedColumn, ...allocationAfter } = (
      await db.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM rateio_allocations`
    )[0];
    expect([
      ...expensesAfter.map((row) => row.documented_schedule),
      ...entriesAfter.map((row) => row.invoice_due_month),
      plannedColumn,
    ]).toEqual([null, null, null, null, null, null, null]);
    expect(
      expensesAfter.map(({ documented_schedule: _schedule, ...row }) => row),
    ).toEqual(beforeExpenses);
    expect(
      entriesAfter.map(({ invoice_due_month: _cycle, ...row }) => row),
    ).toEqual(beforeEntries);
    expect([allocationAfter]).toEqual(beforeAllocations);
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    expect(
      execFileSync(
        'sqlite3',
        [
          backup,
          "SELECT count(*) FROM pragma_table_info('expenses') WHERE name='documented_schedule'",
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('0');
    expect(
      execFileSync('sqlite3', [backup, 'PRAGMA integrity_check'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('ok');

    const service = new DocumentedScheduleService(db);
    const scope = {
      tenantId: 'schedule-upgrade-tenant',
      projectId: 'schedule-upgrade-project',
      cardId: 'legacy-card',
      importId: 'legacy-import',
      expenseId: 'source',
    };
    const requester = { id: 'legacy-actor', role: 'OWNER' };
    const changes = [
      {
        cashFlowEntryId: 'entry',
        amountCents: 12343,
        invoiceDueMonth: '2026-11',
        evidence: {
          documentSha256: 'e'.repeat(64),
          reference: 'Synthetic legacy evidence',
        },
      },
    ];
    const preview = await service.correct(scope, requester, {
      mode: 'preview',
      changes,
    });
    if (!('fingerprint' in preview)) throw new Error('Expected legacy preview');
    await service.correct(scope, requester, {
      mode: 'apply',
      requestId: 'legacy-upgrade-correction',
      expectedFingerprint: preview.fingerprint,
      changes,
    });
    const corrected = await db.rateioAllocation.findUniqueOrThrow({
      where: { id: 'allocation' },
    });
    expect(corrected).toMatchObject({
      allocation: 12343,
      plannedValor: 7000,
      plannedQuantidade: 2,
      plannedValorTotal: 14000,
      plannedDocumentedSchedule: null,
      plannedInstallmentDateOverrides: '{"1":"2026-09-15"}',
    });
    await db.$transaction((tx) =>
      new ConciliacaoService(db!).unratearSource(
        tx,
        {
          tenantId: scope.tenantId,
          sourceExpenseId: scope.expenseId,
        },
        requester,
      ),
    );
    expect(
      await db.expense.findUniqueOrThrow({ where: { id: 'target' } }),
    ).toMatchObject({
      valorTotal: 14000,
      quantidade: 2,
      documentedSchedule: null,
      installmentDateOverrides: '{"1":"2026-09-15"}',
    });
    const raw = (
      await db.expense.findUniqueOrThrow({ where: { id: 'source' } })
    ).documentedSchedule!;
    const assistedScope = {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      cardId: scope.cardId,
      expenseId: 'manual',
    };
    const assisted = {
      changes: [
        {
          cashFlowEntryId: 'manual-entry',
          amountCents: 12344,
          evidence: changes[0].evidence,
        },
      ],
      assistance: {
        basis: 'no-import-reference',
        reason: 'Synthetic legacy manual correction',
        evidence: changes[0].evidence,
      },
    };
    const manualPreview = await service.correctAssisted(
      assistedScope,
      requester,
      { mode: 'preview', ...assisted },
    );
    await service.correctAssisted(assistedScope, requester, {
      mode: 'apply',
      requestId: 'legacy-upgrade-assisted',
      expectedFingerprint: manualPreview.fingerprint,
      ...assisted,
    });
    const manual = await db.expense.findUniqueOrThrow({
      where: { id: 'manual' },
    });
    expect(manual).toMatchObject({
      valorTotal: 12344,
      importId: null,
      externalId: null,
    });
    const v2 = parseStoredExpenseSchedule(manual.documentedSchedule);
    expect(v2).toMatchObject({
      version: 2,
      provenance: { originalImportId: null },
    });
    expect(parseStoredExpenseSchedule(JSON.stringify(v2))).toEqual(v2);
    expect(parseStoredExpenseSchedule(raw)?.version).toBe(1);
    expect(serializeFinancialScheduleResponse(manual)).toMatchObject({
      schedule: { version: 1, occurrences: [{ valor: 12344 }] },
    });
    await db.$transaction(async (tx) => {
      await tx.expense.update({
        where: { id: 'source' },
        data: { documentedSchedule: raw },
      });
      await tx.cashFlowEntry.update({
        where: { id: 'entry' },
        data: { invoiceDueMonth: '2026-11' },
      });
      await tx.expense.delete({ where: { id: 'source' } });
      expect(await tx.expense.findMany({ where: { id: 'source' } })).toEqual(
        [],
      );
      expect(
        (await tx.expense.findUniqueOrThrow({ where: { id: 'source' } }))
          .documentedSchedule,
      ).toBe(raw);
    });
    const stored = await db.expense.findUniqueOrThrow({
      where: { id: 'source' },
    });
    expect(stored.deletedAt).not.toBeNull();
    expect(serializeFinancialScheduleResponse(stored)).toMatchObject({
      schedule: {
        version: 1,
        occurrences: [{ index: 0, valor: 12343, invoiceDueMonth: '2026-11' }],
      },
    });
    expect(
      await db.rateioAllocation.count({ where: { tenantId: scope.tenantId } }),
    ).toBe(0);
  } finally {
    await db?.$disconnect();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (owned && realpathSync(directory) === directory)
      rmSync(directory, { recursive: true });
  }
}, 30000);
