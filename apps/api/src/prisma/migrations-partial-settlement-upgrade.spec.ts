require("../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { ExpenseService } from "../expense/expense.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import {
  applyParcelaFunding,
  undoParcelaFunding,
} from "../conciliacao/additive-settlement";

const root = resolve(__dirname, "../../../..");
const migration = "20260923190000_additive_partial_settlements";

it("upgrades the same backed-up legacy database without financial backfill, then applies and undoes through real middleware", async () => {
  const directory = join(
    root,
    "prisma",
    `test-partial-upgrade-${randomUUID()}`,
  );
  const previousUrl = process.env.DATABASE_URL;
  let owned = false;
  let db: PrismaClient | undefined;
  let service: PrismaService | undefined;
  try {
    mkdirSync(directory);
    owned = true;
    const file = join(directory, "test-partial-upgrade.db");
    const backup = join(directory, "legacy-backup.db");
    const url = `file:${file}`;
    const guard = require("../../../../scripts/test-db-env.cjs");
    expect(guard.forbiddenReason(url)).toBeNull();
    const migrations = join(directory, "migrations");
    mkdirSync(migrations);
    cpSync(
      join(root, "prisma/migrations/migration_lock.toml"),
      join(migrations, "migration_lock.toml"),
    );
    for (const name of readdirSync(join(root, "prisma/migrations")).sort()) {
      if (name < migration && /^\d/.test(name))
        cpSync(join(root, "prisma/migrations", name), join(migrations, name), {
          recursive: true,
        });
    }
    const schema = join(directory, "schema.prisma");
    writeFileSync(
      schema,
      readFileSync(join(root, "prisma/schema.prisma"), "utf8"),
    );
    const deploy = () =>
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
          cwd: root,
          env: { ...process.env, DATABASE_URL: url },
          stdio: "pipe",
        },
      );
    deploy();
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");
    const tenantId = "upgrade-702-tenant";
    const projectId = "upgrade-702-bank";
    const targetProject = "upgrade-702-target";
    await db.tenant.create({
      data: { id: tenantId, name: "Synthetic legacy" },
    });
    await db.project.createMany({
      data: [
        { id: projectId, tenantId, name: "Bank", type: "PESSOAL" },
        { id: targetProject, tenantId, name: "Target", type: "REFORMA" },
      ],
    });
    await db.user.create({
      data: {
        id: "upgrade-702-user",
        username: "upgrade-702-user",
        name: "Synthetic",
        tenantId,
        role: "ADMIN",
      },
    });
    await db.bankAccount.create({
      data: {
        id: "upgrade-702-account",
        tenantId,
        projectId,
        nickname: "Synthetic",
        last4: "0702",
        institution: "ITAU",
      },
    });
    await db.expense.createMany({
      data: [
        {
          id: "legacy-source",
          tenantId,
          projectId,
          tipoDespesa: "OUTROS",
          valor: 12345,
          valorTotal: 12345,
          formaPagamento: "A_VISTA",
          status: "PAGO",
          linkedExpenseId: "legacy-target",
        },
        {
          id: "legacy-target",
          tenantId,
          projectId: targetProject,
          tipoDespesa: "OUTROS",
          valor: 80000,
          valorTotal: 80000,
          formaPagamento: "A_VISTA",
          status: "PAGO",
        },
        {
          id: "legacy-tombstone",
          tenantId,
          projectId,
          tipoDespesa: "OUTROS",
          valor: 12345,
          valorTotal: 12345,
          formaPagamento: "A_VISTA",
          status: "PAGO",
          deletedAt: new Date("2026-01-01"),
        },
      ],
    });
    await db.cashFlowEntry.createMany({
      data: [
        {
          id: "legacy-projection",
          tenantId,
          projectId: targetProject,
          expenseId: "legacy-target",
          tipo: "DESPESA",
          categoria: "Outros",
          valor: 12345,
          data: new Date("2026-09-10"),
          status: "PAGO",
        },
        {
          id: "legacy-deleted-cfe",
          tenantId,
          projectId,
          expenseId: "legacy-tombstone",
          tipo: "DESPESA",
          categoria: "Outros",
          valor: 12345,
          data: new Date("2026-01-01"),
          status: "PAGO",
          deletedAt: new Date("2026-01-01"),
        },
      ],
    });
    await db.$executeRaw`INSERT INTO cross_project_settlements
      (id, tenant_id, source_expense_id, target_expense_id, parcela_index, real_valor, planned_valor, planned_status)
      VALUES ('legacy-settlement', ${tenantId}, 'legacy-source', 'legacy-target', 0, 12345, 80000, 'PLANEJADO')`;
    for (const [label, real, planned] of [
      ["equal", 12345, 12345],
      ["greater", 23456, 12345],
    ] as const) {
      const sourceId = `legacy-source-${label}`;
      const targetId = `legacy-target-${label}`;
      await db.expense.createMany({
        data: [
          {
            id: sourceId,
            tenantId,
            projectId,
            tipoDespesa: "OUTROS",
            valor: real,
            valorTotal: real,
            formaPagamento: "A_VISTA",
            status: "PAGO",
            linkedExpenseId: targetId,
          },
          {
            id: targetId,
            tenantId,
            projectId: targetProject,
            tipoDespesa: "OUTROS",
            valor: 2 * planned,
            valorTotal: 2 * planned,
            formaPagamento: "PARCELADO",
            quantidadeParcela: 2,
            dataInicioParcela: new Date("2026-09-20"),
            status: "PLANEJADO",
            paidParcelas: "[1]",
          },
        ],
      });
      await db.cashFlowEntry.createMany({
        data: [0, 1].map((index) => ({
          id: `${targetId}-${index}`,
          tenantId,
          projectId: targetProject,
          expenseId: targetId,
          tipo: "DESPESA",
          categoria: "Outros",
          valor: index ? real : planned,
          data: new Date(`2026-${index ? "10" : "09"}-20`),
          status: index ? "PAGO" : "PLANEJADO",
          parcela: `${index + 1}/2`,
        })),
      });
      await db.$executeRaw`INSERT INTO cross_project_settlements
        (id, tenant_id, source_expense_id, target_expense_id, parcela_index, real_valor, planned_valor, planned_status)
        VALUES (${`legacy-settlement-${label}`}, ${tenantId}, ${sourceId}, ${targetId}, 1, ${real}, ${planned}, 'PLANEJADO')`;
    }
    const legacy = await db.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM cross_project_settlements`;
    const before = {
      expenses: await db.expense.findMany(),
      cash: await db.cashFlowEntry.findMany(),
    };
    await db.$disconnect();
    execFileSync("sqlite3", [file, `.backup '${backup}'`], { stdio: "pipe" });
    cpSync(
      join(root, "prisma/migrations", migration),
      join(migrations, migration),
      { recursive: true },
    );
    deploy();
    await db.$connect();
    expect({
      expenses: await db.expense.findMany(),
      cash: await db.cashFlowEntry.findMany(),
    }).toEqual(before);
    expect(await db.$queryRaw`SELECT * FROM cross_project_settlements`).toEqual(
      legacy.map((row) => ({
        ...row,
        mode: "LEGACY_REPLACEMENT",
        request_id: null,
        reversed_at: null,
        reversed_by_user_id: null,
        created_by_user_id: null,
        source_cash_flow_entry_id: null,
        target_paid_cash_flow_entry_id: null,
        target_pending_cash_flow_entry_id: null,
        snapshot: null,
      })),
    );
    await expect(
      db.crossProjectSettlement.create({
        data: {
          tenantId,
          sourceExpenseId: "legacy-source",
          targetExpenseId: "legacy-target",
          parcelaIndex: 0,
          realValor: 12345,
          plannedValor: 80000,
          plannedStatus: "PLANEJADO",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.crossProjectSettlement.create({
        data: {
          tenantId,
          mode: "ADDITIVE",
          sourceExpenseId: "legacy-source",
          targetExpenseId: "legacy-target",
          parcelaIndex: 0,
          realValor: 0,
          plannedValor: 80000,
          plannedStatus: "PLANEJADO",
        },
      }),
    ).rejects.toThrow();
    process.env.DATABASE_URL = url;
    service = new PrismaService();
    const expenses = new ExpenseService(
      service,
      new ConciliacaoService(service),
    );
    const source = await expenses.create(tenantId, projectId, {
      valor: 123.45,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      tipoDespesa: "OUTROS",
      dataPagamento: "2026-09-10",
      bankAccountId: "upgrade-702-account",
    });
    const target = await expenses.create(tenantId, targetProject, {
      valor: 800,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PLANEJADO",
      tipoDespesa: "OUTROS",
      dataPagamento: "2026-09-20",
    });
    const actor = { id: "upgrade-702-user", role: "ADMIN" };
    await service.$transaction((tx) =>
      new ConciliacaoService(service!).unsettleBySource(
        tx,
        { tenantId, sourceExpenseId: "legacy-source" },
        actor,
      ),
    );
    expect(
      await service.expense.findUniqueOrThrow({
        where: { id: "legacy-target" },
      }),
    ).toMatchObject({ status: "PLANEJADO", valorTotal: 80000 });
    const funded = await applyParcelaFunding(
      service,
      tenantId,
      projectId,
      source.id,
      {
        mode: "ADDITIVE",
        targetExpenseId: target.id,
        parcelaIndex: 0,
        amountCents: 12345,
        requestId: "upgrade-702-request",
      },
      actor,
    );
    expect(funded.remainingCents).toBe(67655);
    const claim = await db.crossProjectSettlement.findUniqueOrThrow({
      where: { id: funded.settlementId },
    });
    await expect(
      db.crossProjectSettlement.create({
        data: {
          ...claim,
          id: "duplicate-active-tuple",
          requestId: "different-key",
          targetPaidCashFlowEntryId: "different-projection",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.crossProjectSettlement.create({
        data: {
          ...claim,
          id: "duplicate-projection",
          requestId: "different-key",
          reversedAt: new Date(),
          reversedByUserId: actor.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await undoParcelaFunding(
      service,
      tenantId,
      projectId,
      source.id,
      funded.settlementId,
      actor,
    );
    await expect(
      db.crossProjectSettlement.create({
        data: {
          ...claim,
          id: "reused-reversed-request",
          targetPaidCashFlowEntryId: "different-projection",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await service.cashFlowEntry.count({
        where: { expenseId: target.id, deletedAt: null },
      }),
    ).toBe(1);
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    expect(
      execFileSync(
        "sqlite3",
        [
          "-readonly",
          backup,
          "SELECT count(*) FROM pragma_table_info('cross_project_settlements') WHERE name='mode'",
        ],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("0");
    expect(
      execFileSync("sqlite3", ["-readonly", backup, "PRAGMA integrity_check"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("ok");
  } finally {
    await service?.$disconnect();
    await db?.$disconnect();
    process.env.DATABASE_URL = previousUrl;
    if (owned && realpathSync(directory) === directory)
      rmSync(directory, { recursive: true });
  }
}, 30000);
