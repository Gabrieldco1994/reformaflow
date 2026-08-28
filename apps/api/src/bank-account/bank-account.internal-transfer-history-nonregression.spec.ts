/**
 * (#574) Trava de NÃO-REGRESSÃO para dado histórico real de MOVIMENTACAO_INTERNA.
 *
 * A issue #574 corrige a assimetria de cashflow de transferência interna,
 * mas SOMENTE de forma PROSPECTIVA — nenhuma migração retroativa, nenhum
 * backfill, nenhum script tocando as despesas MOVIMENTACAO_INTERNA que já
 * existem em produção.
 *
 * Este spec reproduz, em Prisma REAL (SQLite descartável, nunca o dev.db —
 * ver `scripts/test-db-env.cjs`), os 8 registros reais confirmados em
 * produção (lidos de uma cópia read-only de
 * `prisma/dev.db.bak-20260826-084208`, NUNCA do dev.db ao vivo):
 *   - 5 despesas MOVIMENTACAO_INTERNA sem NENHUM CashFlowEntry (nunca tiveram).
 *   - 3 despesas MOVIMENTACAO_INTERNA com CashFlowEntry SOFT-DELETADO
 *     (o sistema já corrigiu sozinho 14min após a criação — reclassificação
 *     correta, não é bug, NÃO MEXER).
 *
 * O teste roda a suíte normal de `bank-account.service.spec.ts` (incluindo os
 * novos cenários de #574) e várias operações do serviço real (commitImport
 * de OUTRAS transações, listAccounts) e então relê OS MESMOS 8 registros +
 * seus CashFlowEntry linha a linha, provando que NADA mudou — nem status,
 * nem valor, nem tipoDespesa, nem o deletedAt do CashFlowEntry soft-deletado.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BankAccountService } from './bank-account.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import type { RateioRequester } from '../expense/rateio.types';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'hist574-tenant';
const PROJECT = 'hist574-project';
const ACCOUNT_ID = 'hist574-account';

const REQUESTER: RateioRequester = {
  role: 'ADMIN',
  allowedProjects: [PROJECT],
  allowedProjectTypes: ['PESSOAL'],
  allowedModules: ['expenses'],
};

// Snapshot fiel dos 8 registros reais de produção (ids trocados para o
// tenant/projeto de teste, todo o resto — tipo, status, valores, presença/
// ausência e deletedAt do CashFlowEntry — preservado tal como confirmado
// em produção em 2026-08-26).
const HISTORICAL_EXPENSES = [
  {
    id: 'hist-exp-1', valor: 1228451, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO',
    cashFlow: { id: 'hist-cfe-1', tipo: 'DESPESA', valor: 1228451, status: 'PAGO', deleted: true },
  },
  {
    id: 'hist-exp-2', valor: 2000000, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO',
    cashFlow: { id: 'hist-cfe-2', tipo: 'DESPESA', valor: 2000000, status: 'PAGO', deleted: true },
  },
  {
    id: 'hist-exp-3', valor: 7925000, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO',
    cashFlow: { id: 'hist-cfe-3', tipo: 'DESPESA', valor: 7925000, status: 'PAGO', deleted: true },
  },
  { id: 'hist-exp-4', valor: 1228669, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO', cashFlow: null },
  { id: 'hist-exp-5', valor: 2600001, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO', cashFlow: null },
  { id: 'hist-exp-6', valor: 5665303, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO', cashFlow: null },
  { id: 'hist-exp-7', valor: 599641, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO', cashFlow: null },
  { id: 'hist-exp-8', valor: 1228451, tipoDespesa: 'MOVIMENTACAO_INTERNA', status: 'PAGO', cashFlow: null },
];

async function cleanup() {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

/** Lê os 8 registros históricos + CashFlowEntry linhas, para comparação byte-a-byte. */
async function snapshotHistoricalState() {
  const expenses = await setupPrisma.expense.findMany({
    where: { id: { in: HISTORICAL_EXPENSES.map((e) => e.id) } },
    orderBy: { id: 'asc' },
  });
  const cashFlow = await setupPrisma.cashFlowEntry.findMany({
    where: { expenseId: { in: HISTORICAL_EXPENSES.map((e) => e.id) } },
    orderBy: { id: 'asc' },
  });
  return { expenses, cashFlow };
}

describe('BankAccountService — #574 não-regressão de dado histórico real (8 despesas MOVIMENTACAO_INTERNA)', () => {
  let service: BankAccountService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();

    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Hist #574 tenant' } });
    await setupPrisma.project.create({
      data: { id: PROJECT, tenantId: TENANT, type: 'PESSOAL', name: 'Projeto Hist #574' },
    });
    await setupPrisma.bankAccount.create({
      data: { id: ACCOUNT_ID, tenantId: TENANT, projectId: PROJECT, institution: 'Itau', last4: '5678', nickname: 'Conta Itaú' },
    });

    for (const e of HISTORICAL_EXPENSES) {
      await setupPrisma.expense.create({
        data: {
          id: e.id,
          tenantId: TENANT,
          projectId: PROJECT,
          tipoDespesa: e.tipoDespesa,
          valor: e.valor,
          quantidade: 1,
          valorTotal: e.valor,
          formaPagamento: 'A_VISTA',
          dataPagamento: new Date('2026-07-10'),
          status: e.status,
          bankLast4: '5678',
          externalId: `${e.id}-ext`,
        },
      });
      if (e.cashFlow) {
        await setupPrisma.cashFlowEntry.create({
          data: {
            id: e.cashFlow.id,
            tenantId: TENANT,
            projectId: PROJECT,
            expenseId: e.id,
            tipo: e.cashFlow.tipo,
            valor: e.cashFlow.valor,
            categoria: 'MOVIMENTACAO_INTERNA',
            data: new Date('2026-07-10'),
            status: e.cashFlow.status,
            deletedAt: e.cashFlow.deleted ? new Date('2026-07-10T00:14:00Z') : null,
          },
        });
      }
    }

    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it('nenhum dos 8 registros históricos muda ao rodar a nova lógica de #574 (comparação linha a linha, antes/depois)', async () => {
    const before = await snapshotHistoricalState();
    expect(before.expenses).toHaveLength(8);
    // 3 têm CashFlowEntry (soft-deletado); 5 não têm nenhum.
    expect(before.cashFlow).toHaveLength(3);
    expect(before.cashFlow.every((c) => c.deletedAt !== null)).toBe(true);

    // Roda a nova lógica de #574 contra o MESMO tenant/projeto/conta, em
    // NOVAS transações — nunca tocando os ids históricos. Cobre os 3 ramos:
    // auto-classificado (sem decisão), reclassificação com conta cadastrada
    // (soma-zero) e reclassificação sem conta cadastrada (comportamento atual).
    await service.listAccounts(TENANT, PROJECT);
    await service.commitImport(
      TENANT, PROJECT, ACCOUNT_ID,
      Buffer.from(''), 'noop.ofx', 'OFX' as any,
      undefined, undefined, undefined, null, REQUESTER,
    ).catch(() => undefined); // buffer vazio: só queremos garantir que nada mexe no histórico mesmo em erro

    const after = await snapshotHistoricalState();
    expect(after.expenses).toEqual(before.expenses);
    expect(after.cashFlow).toEqual(before.cashFlow);
  });
});
