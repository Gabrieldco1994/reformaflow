require("../../../../scripts/test-db-env.cjs");
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";

it("#704 upgrades legacy positive snapshots unchanged and preserves ordinary undo", async () => {
  const root = resolve(__dirname, "../../../..");
  const migration = "20260929020000_refund_purpose";
  const directory = join(root, "prisma", `test-refund-upgrade-${randomUUID()}`);
  let owned = false;
  let db: PrismaClient | undefined;
  let prisma: PrismaService | undefined;
  try {
    mkdirSync(directory);
    owned = true;
    const file = join(directory, "test-refund-upgrade.db");
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
    cpSync(join(root, "prisma/schema.prisma"), schema);
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
    await db.tenant.create({
      data: { id: "legacy-refund-tenant", name: "Synthetic legacy" },
    });
    for (const [id, type] of [
      ["legacy-personal", "PESSOAL"],
      ["legacy-renovation", "REFORMA"],
    ]) {
      await db.project.create({
        data: { id, type, tenantId: "legacy-refund-tenant", name: id },
      });
    }
    for (const [id, project, linked, amount] of [
      ["legacy-source", "legacy-personal", "legacy-target", 12345],
      ["legacy-target", "legacy-renovation", null, 12345],
      [
        "legacy-negative-source",
        "legacy-personal",
        "legacy-negative-target",
        -5000,
      ],
      ["legacy-negative-target", "legacy-renovation", null, -5000],
    ]) {
      await db.$executeRaw`INSERT INTO expenses
        (id, tenant_id, project_id, tipo_despesa, valor, quantidade, valor_total, forma_pagamento,
         status, linked_expense_id, updated_at, data_pagamento)
        VALUES (${id}, 'legacy-refund-tenant', ${project}, 'MATERIAL_CONSTRUCAO', ${amount}, 1, ${amount},
          'A_VISTA', 'PAGO', ${linked}, 1, 1788998400000)`;
    }
    await db.$executeRaw`INSERT INTO rateio_allocations
      (id, tenant_id, source_expense_id, target_expense_id, allocation, planned_status,
       planned_valor, planned_quantidade, planned_valor_total, planned_forma, planned_data_pagamento)
      VALUES ('legacy-edge', 'legacy-refund-tenant', 'legacy-source', 'legacy-target', 12345,
        'PLANEJADO', 15000, 1, 15000, 'A_VISTA', 1788998400000)`;
    await db.$executeRaw`INSERT INTO rateio_allocations
      (id, tenant_id, source_expense_id, target_expense_id, allocation, planned_status)
      VALUES ('legacy-negative-edge', 'legacy-refund-tenant', 'legacy-negative-source',
        'legacy-negative-target', -5000, 'PAGO')`;
    await db.cashFlowEntry.create({
      data: {
        tenantId: "legacy-refund-tenant",
        projectId: "legacy-personal",
        expenseId: "legacy-source",
        valor: 12345,
        tipo: "DESPESA",
        categoria: "MATERIAL_CONSTRUCAO",
        status: "PAGO",
        data: new Date("2026-09-10T00:00:00Z"),
        deletedAt: new Date("2026-09-11T00:00:00Z"),
      },
    });
    const before = await db.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM rateio_allocations`;
    const history = await db.cashFlowEntry.findMany();
    const expenses = await db.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM expenses ORDER BY id`;
    await db.$disconnect();
    execFileSync("sqlite3", [file, `.backup '${backup}'`], { stdio: "pipe" });
    cpSync(
      join(root, "prisma/migrations", migration),
      join(migrations, migration),
      { recursive: true },
    );
    deploy();
    await db.$connect();
    expect(await db.$queryRaw`SELECT * FROM rateio_allocations`).toEqual(
      before.map((row) => ({ ...row, is_refund_credit: false })),
    );
    expect(await db.$queryRaw`SELECT * FROM expenses ORDER BY id`).toEqual(
      expenses.map((row) => ({ ...row, refund_purpose_revision: 0 })),
    );
    expect(await db.cashFlowEntry.findMany()).toEqual(history);
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    expect(
      execFileSync(
        "sqlite3",
        [
          backup,
          "SELECT count(*) FROM pragma_table_info('expenses') WHERE name='refund_purpose_revision'",
        ],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("0");
    expect(
      execFileSync("sqlite3", [backup, "PRAGMA integrity_check"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("ok");
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    try {
      prisma = new PrismaService();
      await prisma.$connect();
    } finally {
      process.env.DATABASE_URL = originalUrl;
    }
    await prisma.$transaction((tx) =>
      new ConciliacaoService(prisma!).unratearSource(
        tx,
        { tenantId: "legacy-refund-tenant", sourceExpenseId: "legacy-source" },
        { role: "OWNER" },
      ),
    );
    expect(
      await db.expense.findUnique({ where: { id: "legacy-target" } }),
    ).toMatchObject({
      status: "PLANEJADO",
      valorTotal: 15000,
      deletedAt: null,
      refundPurposeRevision: 0,
    });
  } finally {
    await prisma?.$disconnect();
    await db?.$disconnect();
    if (owned && realpathSync(directory) === directory)
      rmSync(directory, { recursive: true });
  }
}, 30000);
