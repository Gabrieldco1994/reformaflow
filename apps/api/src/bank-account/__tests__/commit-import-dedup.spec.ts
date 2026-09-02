import * as XLSX from 'xlsx';
import { Test } from '@nestjs/testing';
import { BankAccountService } from '../bank-account.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MerchantClassifierService } from '../../merchant-classifier/merchant-classifier.service';
import { CardInvoiceSettlementService } from '../../credit-card/card-invoice-settlement.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';
import { TEST_OWNER_REQUESTER } from '../../test-utils/acl-requester-test-helper';

/**
 * Cobre dois cenários de "excluir/retirar algo não deveria voltar a contar":
 *
 *  1) Decisão "skip" no preview (usuário desmarca uma linha antes de importar):
 *     já funcionava corretamente — mantido aqui como regressão.
 *  2) Reimportar o MESMO extrato depois de excluir (soft-delete) um lançamento
 *     já importado: tinha um bug real — findExistingExternalIds() filtrava
 *     deletedAt:null e não enxergava o registro excluído, então o importador
 *     achava que a transação era nova e recriava. Corrigido usando $queryRaw
 *     (bypassa o middleware de soft-delete só pra esse check de existência).
 */

function xlsxBuf(rows: string[][]) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function makePrismaMock() {
  const prisma = {
    bankAccount: { findFirst: jest.fn() },
    bankStatementImport: { create: jest.fn().mockResolvedValue({ id: 'imp1' }), update: jest.fn().mockResolvedValue({}) },
    expense: {
      create: jest.fn().mockResolvedValue({ id: 'exp1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    receipt: {
      create: jest.fn().mockResolvedValue({ id: 'rec1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    cashFlowEntry: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'pessoal1', type: 'PESSOAL' }), findMany: jest.fn().mockResolvedValue([]) },
    creditCardStatementImport: { update: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    creditCard: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
    recurringBill: { create: jest.fn(), findFirst: jest.fn() },
    crossProjectSettlement: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
  prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
  return prisma;
}

async function buildService(prisma: any) {
  const module = await Test.createTestingModule({
    providers: [
      BankAccountService,
      ConciliacaoService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: MerchantClassifierService,
        useValue: {
          classifyBatch: jest.fn().mockResolvedValue(new Map()),
          manualExpenseType: jest.fn().mockResolvedValue(null),
          resolveLearnedExpenseType: jest.fn().mockResolvedValue({
            expenseType: null,
            source: null,
            confidence: null,
            category: null,
            reason: 'sem-regra',
          }),
        },
      },
      CardInvoiceSettlementService,
    ],
  }).compile();
  return module.get(BankAccountService);
}

describe('commitImport — decisão skip não contabiliza a linha', () => {
  it('linha marcada como skip no preview NÃO é criada no commit (mesmo arquivo xlsx)', async () => {
    const prisma = makePrismaMock();
    prisma.bankAccount.findFirst.mockResolvedValue({ id: 'acc1', last4: '1234', nickname: 'Conta X', tenantId: 't1' });
    const service = await buildService(prisma);

    const rows = [
      ['data', 'descricao', 'valor'],
      ['20/07/2026', 'CREDITO LIBERAD PIX 6933', '3.500,00'],
      ['20/07/2026', 'PIX CARTAO Alessan18/07', '-3.500,00'],
      ['21/07/2026', 'MERCADO XYZ', '-150,00'],
    ];
    const buf = xlsxBuf(rows);

    const preview = await service.previewImport('t1', 'pessoal1', 'acc1', buf, 'extrato.xlsx', 'AUTO', undefined, TEST_OWNER_REQUESTER);
    const mercadoTx = preview.preview.find((p: any) => /MERCADO/.test(p.merchant));
    expect(mercadoTx).toBeDefined();

    prisma.expense.create.mockClear();
    prisma.receipt.create.mockClear();
    const res = await service.commitImport(
      't1', 'pessoal1', 'acc1', buf, 'extrato.xlsx', 'AUTO',
      undefined, undefined,
      [{ externalId: mercadoTx!.externalId, action: 'skip' }], null, TEST_OWNER_REQUESTER
    );

    const createdMercado = prisma.expense.create.mock.calls.find((c: any) => /MERCADO/.test(c[0].data.fornecedor ?? ''));
    expect(createdMercado).toBeUndefined();
    expect(res.skipped).toBe(1);
  });

  it('skip em linha de crédito (recebimento) não cria Receipt', async () => {
    const prisma = makePrismaMock();
    prisma.bankAccount.findFirst.mockResolvedValue({ id: 'acc1', last4: '1234', nickname: 'Conta X', tenantId: 't1' });
    const service = await buildService(prisma);

    const rows = [
      ['data', 'descricao', 'valor'],
      ['20/07/2026', 'CREDITO LIBERAD PIX 6933', '3.500,00'],
    ];
    const buf = xlsxBuf(rows);

    const preview = await service.previewImport('t1', 'pessoal1', 'acc1', buf, 'extrato.xlsx', 'AUTO', undefined, TEST_OWNER_REQUESTER);
    const tx = preview.preview[0];

    prisma.receipt.create.mockClear();
    const res = await service.commitImport(
      't1', 'pessoal1', 'acc1', buf, 'extrato.xlsx', 'AUTO',
      undefined, undefined,
      [{ externalId: tx.externalId, action: 'skip' }], null, TEST_OWNER_REQUESTER
    );

    expect(prisma.receipt.create).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });
});

describe('commitImport — múltiplos arquivos no mesmo import não perdem transação por colisão de externalId', () => {
  it('2 arquivos xlsx, cada um com 1 transação idêntica (mesma data/desc/valor) -> gera 2 despesas distintas, não 1', async () => {
    const prisma = makePrismaMock();
    prisma.bankAccount.findFirst.mockResolvedValue({ id: 'acc1', last4: '1234', nickname: 'Conta X', tenantId: 't1' });
    const service = await buildService(prisma);

    const headerAndRow = [
      ['data', 'descricao', 'valor'],
      ['15/07/2026', 'MERCADO ABC', '-100,00'],
    ];
    const file1 = xlsxBuf(headerAndRow);
    const file2 = xlsxBuf(headerAndRow); // linha idêntica em outro arquivo (2 exports/contas)

    const preview = await service.previewImport('t1', 'pessoal1', 'acc1', [file1, file2], 'ext.xlsx', 'AUTO', undefined, TEST_OWNER_REQUESTER);
    expect(preview.total).toBe(2);

    prisma.expense.create.mockClear();
    const res = await service.commitImport('t1', 'pessoal1', 'acc1', [file1, file2], 'ext.xlsx', 'AUTO', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);
    expect(res.inserted).toBe(2);
    expect(prisma.expense.create).toHaveBeenCalledTimes(2);
  });
});

describe('commitImport — excluir (soft-delete) um lançamento importado e reimportar o mesmo extrato', () => {
  it('NÃO recria a despesa: findExistingExternalIds enxerga registros soft-deletados via $queryRaw', async () => {
    const prisma = makePrismaMock();
    prisma.bankAccount.findFirst.mockResolvedValue({ id: 'acc1', last4: '1234', nickname: 'Conta X', tenantId: 't1' });

    // Simula a tabela real: uma vez criada, a linha nunca "some" fisicamente —
    // soft-delete só marca deletedAt, então $queryRaw (que não filtra deletedAt)
    // continua enxergando o externalId.
    const expenseRows: { external_id: string }[] = [];
    prisma.expense.create.mockImplementation(({ data }: any) => {
      if (data.externalId) expenseRows.push({ external_id: data.externalId });
      return Promise.resolve({ id: `exp${expenseRows.length}` });
    });
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM expenses')) return Promise.resolve(expenseRows);
      return Promise.resolve([]);
    });

    const service = await buildService(prisma);
    const rows = [
      ['data', 'descricao', 'valor'],
      ['15/07/2026', 'MERCADO ABC', '-100,00'],
    ];
    const buf = xlsxBuf(rows);

    // 1ª importação: cria a despesa.
    const res1 = await service.commitImport('t1', 'pessoal1', 'acc1', buf, 'extrato.xlsx', 'AUTO', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);
    expect(res1.inserted).toBe(1);
    expect(expenseRows).toHaveLength(1);

    // Usuário exclui a despesa na UI (soft-delete: deletedAt=now). A linha
    // continua existindo fisicamente (expenseRows não muda), só passa a ter
    // deletedAt setado — não simulamos isso à parte pois $queryRaw não filtra
    // por deletedAt de propósito (é esse o ponto do fix).

    // 2ª importação: MESMO arquivo — a despesa excluída NÃO deve voltar.
    prisma.expense.create.mockClear();
    const res2 = await service.commitImport('t1', 'pessoal1', 'acc1', buf, 'extrato.xlsx', 'AUTO', undefined, undefined, undefined, null, TEST_OWNER_REQUESTER);
    expect(res2.inserted).toBe(0);
    expect(prisma.expense.create).not.toHaveBeenCalled();

    // Auditabilidade (Fase 3): o que foi ignorado como duplicata precisa vir
    // ITEMIZADO no resultado — não só a contagem. Sem isso a linha some sem rastro.
    expect(res2.duplicated).toBe(1);
    expect(res2.duplicatedItems).toHaveLength(1);
    expect(res2.duplicatedItems[0]).toMatchObject({
      description: 'MERCADO ABC',
      amountCents: 10000,
      reason: 'duplicate',
    });
  });
});
