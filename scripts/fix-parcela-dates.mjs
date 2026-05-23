#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

function buildEntries(expense) {
  const base = {
    projectId: expense.projectId,
    tenantId: expense.tenantId,
    expenseId: expense.id,
    tipo: 'DESPESA',
    categoria: expense.tipoDespesa,
    subcategoria: expense.categoriaMaoDeObra ?? null,
    ambiente: expense.room?.nome ?? null,
    status: expense.status === 'PAGO' || expense.status === 'EM_CAIXA'
      ? expense.status
      : 'PLANEJADO',
  };

  if (expense.formaPagamento === 'A_VISTA') {
    return [{
      ...base,
      valor: expense.valorTotal,
      data: expense.dataPagamento ?? new Date(),
      formaPagamento: 'A_VISTA',
      parcela: null,
    }];
  }

  const n = expense.quantidadeParcela ?? 1;
  const baseValue = Math.floor(expense.valorTotal / n);
  const remainder = expense.valorTotal - baseValue * n;
  const startDate = expense.dataInicioParcela ?? new Date();
  const isQuinzenal = expense.formaPagamento === 'QUINZENAL';

  const entries = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(startDate);
    if (isQuinzenal) {
      d.setUTCDate(d.getUTCDate() + i * 15);
    } else {
      const targetMonth = d.getUTCMonth() + i;
      const targetDay = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(targetMonth);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(targetDay, lastDay));
    }
    entries.push({
      ...base,
      valor: i === n - 1 ? baseValue + remainder : baseValue,
      data: d,
      formaPagamento: expense.formaPagamento,
      parcela: `${i + 1}/${n}`,
    });
  }
  return entries;
}

const expenses = await prisma.expense.findMany({
  where: {
    deletedAt: null,
    settledByExpenseId: null,
    formaPagamento: { in: ['PARCELADO', 'QUINZENAL'] },
  },
  include: { room: true },
});

console.log(`Found ${expenses.length} expenses to regenerate.`);

let total = 0;
for (const exp of expenses) {
  const newEntries = buildEntries(exp);
  await prisma.$transaction(async (tx) => {
    await tx.cashFlowEntry.updateMany({
      where: { expenseId: exp.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (newEntries.length > 0) {
      const data = newEntries.map((e) => ({
        ...e,
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      await tx.cashFlowEntry.createMany({ data });
    }
  });
  total += newEntries.length;
  console.log(`  [${exp.formaPagamento}] ${exp.titulo} (${exp.quantidadeParcela}x) -> ${newEntries.length} entries`);
}

console.log(`\nDone. Recreated ${total} cash flow entries.`);
await prisma.$disconnect();
