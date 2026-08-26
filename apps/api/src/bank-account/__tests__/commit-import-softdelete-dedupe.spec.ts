/**
 * #570 (Fase 1) — reimportar o MESMO extrato bancário depois de excluir
 * (soft-delete) uma despesa importada NÃO deve ressuscitá-la/duplicá-la.
 *
 * Contrato (já implementado do lado Conta desde antes da #568, ver
 * findExistingExternalIds em bank-account.service.ts): exclusão é
 * definitiva, não "esqueça que já importei". Este arquivo materializa o
 * cenário com Prisma REAL (PrismaService real do Nest + SQLite descartável
 * do worktree, nunca `new PrismaClient()` bruto nem mock manual das tabelas)
 * — replica para o lado Conta o mesmo padrão do lado Cartão
 * (credit-card/__tests__/commit-import-softdelete-dedupe.spec.ts, #568).
 *
 * Este teste é a LINHA DE BASE da #570: precisa passar ANTES de qualquer
 * mudança de schema, provando que o dedupe de aplicação já é sólido antes
 * de adicionar o índice único físico por cima (defesa contra TOCTOU).
 */
// O guard do banco de teste precisa carregar ANTES de qualquer import do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');

import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { BankAccountService } from '../bank-account.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../../merchant-classifier/merchant-classifier.service';
import { CardInvoiceSettlementService } from '../../credit-card/card-invoice-settlement.service';
import { TEST_OWNER_REQUESTER } from '../../test-utils/acl-requester-test-helper';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'ba570-tenant';
const PROJECT = 'ba570-project';

function xlsxBuf(rows: string[][]) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function cleanup() {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

describe('BankAccountService — reimportar extrato após soft-delete não recria a despesa (#570 Fase 1)', () => {
  let service: BankAccountService;
  let accountId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Conta dedupe soft-delete tenant' } });
    await setupPrisma.project.create({
      data: { id: PROJECT, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
    });
    const account = await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT,
        projectId: PROJECT,
        institution: 'ITAU',
        nickname: 'Conta Corrente',
        last4: '4321',
      },
    });
    accountId = account.id;
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

  const rows = [
    ['data', 'descricao', 'valor'],
    ['15/07/2026', 'MERCADO ABC', '-100,00'],
  ];

  it('NÃO recria a despesa: findExistingExternalIds enxerga soft-deletados', async () => {
    const buf = xlsxBuf(rows);

    // 1ª importação: cria a despesa.
    const r1 = await service.commitImport(
      TENANT, PROJECT, accountId, buf, 'extrato.xlsx', 'AUTO' as any,
      undefined, undefined, undefined, null, TEST_OWNER_REQUESTER,
    );
    expect(r1.inserted).toBe(1);
    expect(r1.duplicated).toBe(0);

    const created = await setupPrisma.expense.findFirst({
      where: { tenantId: TENANT, projectId: PROJECT, bankLast4: '4321' },
    });
    expect(created).toBeTruthy();
    expect(created!.deletedAt).toBeNull();

    // Usuário exclui a despesa na UI: soft-delete real (deletedAt=now), a
    // linha continua fisicamente na tabela.
    await setupPrisma.expense.update({
      where: { id: created!.id },
      data: { deletedAt: new Date() },
    });

    // 2ª importação: MESMO extrato — a despesa excluída NÃO deve voltar.
    const buf2 = xlsxBuf(rows);
    const r2 = await service.commitImport(
      TENANT, PROJECT, accountId, buf2, 'extrato.xlsx', 'AUTO' as any,
      undefined, undefined, undefined, null, TEST_OWNER_REQUESTER,
    );
    expect(r2.inserted).toBe(0);
    expect(r2.duplicated).toBe(1);
    expect(r2.duplicatedItems).toHaveLength(1);
    expect(r2.duplicatedItems[0]).toMatchObject({
      description: 'MERCADO ABC',
      amountCents: 10000,
      reason: 'duplicate',
    });

    // Confirma no banco: continua existindo só 1 linha (a soft-deletada
    // original), nenhuma nova ativa foi criada.
    const all = await setupPrisma.expense.findMany({
      where: { tenantId: TENANT, projectId: PROJECT, bankLast4: '4321' },
    });
    expect(all).toHaveLength(1);
    expect(all[0].deletedAt).not.toBeNull();
  });
});
