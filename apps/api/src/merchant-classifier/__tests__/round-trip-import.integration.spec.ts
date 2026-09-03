/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AC#7 (#582) — "corrija uma vez": o override EXPLÍCITO de categoria no preview
 * de importação, depois que a linha é efetivamente importada, vira regra MANUAL
 * tenant-scoped. O mês seguinte já cai como `categoriaFonte: 'regra'` sem nova
 * correção.
 *
 * Round-trip com Prisma real (prisma/test.db do worktree, NUNCA dev.db):
 *   1) preview do arquivo A (merchant sem regra) → cai no heurístico local.
 *   2) commit do A com overrides.category → despesa criada + `rulesLearned === 1`
 *      + `MerchantCategory` MANUAL persistida.
 *   3) preview do arquivo B (mesmo merchant, outro externalId) → sugestão vem da
 *      regra (`categoriaFonte === 'regra'`), zero chamada Gemini.
 *   4) outro tenant NÃO vê a regra.
 *   5) tipo sem `MerchantCategory` equivalente → `rulesSkippedNoMapping`, 0 regra.
 *   6) linha `skip` ou duplicada com override → NÃO ensina.
 *
 * A trava precisa carregar ANTES de qualquer `new PrismaClient()` (regra #17).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');
import { PrismaClient } from '@prisma/client';
import { BankAccountService } from '../../bank-account/bank-account.service';
import { CardInvoiceSettlementService } from '../../credit-card/card-invoice-settlement.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { RateioRequester } from '../../expense/rateio.types';

const MERCHANT = 'PADARIA DoZé';
const KEY = MerchantClassifierService.normalizeKey(MERCHANT);

const IDS = {
  tenantA: 'rt582-tenant-a',
  tenantB: 'rt582-tenant-b',
  projectA: 'rt582-pessoal-a',
  accountA: 'rt582-account-a',
};

const requester: RateioRequester = {
  role: 'OWNER',
  allowedProjects: [IDS.projectA],
  allowedProjectTypes: ['PESSOAL'],
  allowedModules: ['expenses', 'bankAccounts'],
};

function csvFor(rows: Array<[string, string, string]>): string {
  return ['date,title,amount', ...rows.map((r) => r.join(','))].join('\n');
}

describe('AC#7 — override de importação cria regra MANUAL tenant-scoped', () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const classifier = new MerchantClassifierService(prisma);
  const service = new BankAccountService(
    prisma,
    classifier,
    new ConciliacaoService(prisma),
    new CardInvoiceSettlementService(prisma),
  );

  const geminiSpy = jest
    .spyOn(MerchantClassifierService.prototype as any, 'callGemini')
    .mockResolvedValue([]);

  async function cleanup() {
    await setup.merchantCategory.deleteMany({ where: { merchantKey: KEY } });
    await setup.cashFlowEntry.deleteMany({ where: { tenantId: { in: [IDS.tenantA, IDS.tenantB] } } });
    await setup.expense.deleteMany({ where: { tenantId: { in: [IDS.tenantA, IDS.tenantB] } } });
    await setup.receipt.deleteMany({ where: { tenantId: { in: [IDS.tenantA, IDS.tenantB] } } });
    await setup.bankStatementImport.deleteMany({ where: { tenantId: { in: [IDS.tenantA, IDS.tenantB] } } });
    await setup.bankAccount.deleteMany({ where: { tenantId: { in: [IDS.tenantA, IDS.tenantB] } } });
    await setup.project.deleteMany({ where: { tenantId: { in: [IDS.tenantA, IDS.tenantB] } } });
    await setup.tenant.deleteMany({ where: { id: { in: [IDS.tenantA, IDS.tenantB] } } });
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setup.tenant.createMany({
      data: [
        { id: IDS.tenantA, name: 'RT582 A' },
        { id: IDS.tenantB, name: 'RT582 B' },
      ],
    });
    await setup.project.create({
      data: { id: IDS.projectA, tenantId: IDS.tenantA, type: 'PESSOAL', name: 'Pessoal A' },
    });
    await setup.bankAccount.create({
      data: {
        id: IDS.accountA,
        tenantId: IDS.tenantA,
        projectId: IDS.projectA,
        institution: 'NUBANK',
        nickname: 'Nubank A',
        last4: '4247',
      },
    });
  });

  afterAll(async () => {
    geminiSpy.mockRestore();
    await cleanup();
    await setup.$disconnect();
    await prisma.$disconnect?.();
  });

  it('aprende do override só depois da linha ser importada com sucesso', async () => {
    // 1) preview A — sem regra ainda
    const csvA = csvFor([
      ['2026-05-12', MERCHANT, '-42.00'],
      ['2026-05-12', 'SEGURO VIDA PORTO', '-90.00'],
    ]);
    const previewA = await service.previewImport(
      IDS.tenantA, IDS.projectA, IDS.accountA, csvA, 'a.csv', 'CSV_GENERIC' as any, undefined, requester,
    );
    const rowA = previewA.preview.find((p: any) => p.merchant === MERCHANT);
    const rowSeguro = previewA.preview.find((p: any) => /SEGURO/.test(p.merchant));
    expect(rowA).toBeDefined();
    expect(rowA!.categoriaFonte).not.toBe('regra');

    // 2) commit A com override explícito + um override sem mapeamento
    const commitA: any = await service.commitImport(
      IDS.tenantA, IDS.projectA, IDS.accountA, csvA, 'a.csv', 'CSV_GENERIC' as any,
      undefined, undefined,
      [
        { externalId: rowA!.externalId, overrides: { category: 'ALIMENTACAO' } },
        { externalId: rowSeguro!.externalId, overrides: { category: 'SEGUROS_PESSOAIS' } },
      ],
      null, requester,
    );
    expect(commitA.inserted).toBe(2);
    expect(commitA.rulesLearned).toBe(1);
    expect(commitA.rulesSkippedNoMapping).toBe(1);
    expect(commitA.rulesLearnFailed).toBe(0);

    const rule = await setup.merchantCategory.findFirst({
      where: { tenantId: IDS.tenantA, merchantKey: KEY },
    });
    expect(rule).toMatchObject({ category: 'alimentação', source: 'MANUAL', subcategory: null });

    // nenhuma regra criada para o tipo sem mapeamento
    const seguroKey = MerchantClassifierService.normalizeKey('SEGURO VIDA PORTO');
    expect(await setup.merchantCategory.count({ where: { merchantKey: seguroKey } })).toBe(0);

    // 3) preview B — mesmo merchant, outro externalId → sugestão pela regra
    const csvB = csvFor([['2026-06-12', MERCHANT, '-51.00']]);
    const previewB = await service.previewImport(
      IDS.tenantA, IDS.projectA, IDS.accountA, csvB, 'b.csv', 'CSV_GENERIC' as any, undefined, requester,
    );
    const rowB = previewB.preview.find((p: any) => p.merchant === MERCHANT);
    expect(rowB!.suggestedCategory).toBe('ALIMENTACAO');
    expect(rowB!.categoriaFonte).toBe('regra');
    expect(geminiSpy).not.toHaveBeenCalled();

    // 4) tenant B não vê a regra
    expect(await classifier.manualExpenseType(MERCHANT, IDS.tenantB)).toBeNull();

    // 5) linha duplicada com override não reensina (nem falha a importação)
    const commitDup: any = await service.commitImport(
      IDS.tenantA, IDS.projectA, IDS.accountA, csvA, 'a.csv', 'CSV_GENERIC' as any,
      undefined, undefined,
      [{ externalId: rowA!.externalId, overrides: { category: 'TRANSPORTE' } }],
      null, requester,
    );
    expect(commitDup.duplicated).toBe(2);
    expect(commitDup.rulesLearned).toBe(0);
    const ruleAfterDup = await setup.merchantCategory.findFirst({
      where: { tenantId: IDS.tenantA, merchantKey: KEY },
    });
    expect(ruleAfterDup?.category).toBe('alimentação'); // não virou "transporte"

    // 6) linha skip com override não ensina
    const csvC = csvFor([['2026-07-12', 'FEIRA DA LUA', '-30.00']]);
    const previewC = await service.previewImport(
      IDS.tenantA, IDS.projectA, IDS.accountA, csvC, 'c.csv', 'CSV_GENERIC' as any, undefined, requester,
    );
    const rowC = previewC.preview[0];
    const commitC: any = await service.commitImport(
      IDS.tenantA, IDS.projectA, IDS.accountA, csvC, 'c.csv', 'CSV_GENERIC' as any,
      undefined, undefined,
      [{ externalId: rowC.externalId, action: 'skip', overrides: { category: 'ALIMENTACAO' } }],
      null, requester,
    );
    expect(commitC.rulesLearned).toBe(0);
    expect(
      await setup.merchantCategory.count({
        where: { merchantKey: MerchantClassifierService.normalizeKey('FEIRA DA LUA') },
      }),
    ).toBe(0);
  });
});
