/**
 * #568 — reimportar uma fatura de cartão depois de excluir (soft-delete) uma
 * despesa importada NÃO deve ressuscitá-la/duplicá-la.
 *
 * Contrato (Rota A, já decidida e testada do lado CONTA em
 * bank-account/__tests__/commit-import-dedup.spec.ts): exclusão é definitiva,
 * não "esqueça que já importei". `findExistingExternalIds` precisa enxergar
 * `externalId`s soft-deletados, senão o importador acha a transação "nova"
 * e recria a despesa que o usuário apagou.
 *
 * No baseline pré-#568, `findExistingExternalIds` (credit-card.service.ts)
 * usava `prisma.expense.findMany({ ..., deletedAt: null })` — cego a
 * soft-deletados, porque o próprio filtro explícito `deletedAt: null` some
 * a linha, e o middleware de soft-delete (`prisma.service.ts` `$use`) já
 * garantiria isso mesmo sem o filtro explícito. Este teste materializa o
 * cenário com Prisma REAL (SQLite descartável) — nada de mock que espelhe a
 * lógica do service, isso provaria a suposição, não o comportamento.
 */
// O guard do banco de teste precisa carregar ANTES de qualquer import do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { CreditCardService } from '../credit-card.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConciliacaoService } from '../../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../../merchant-classifier/merchant-classifier.service';
import { TEST_OWNER_REQUESTER } from '../../test-utils/acl-requester-test-helper';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'cc568-tenant';
const PROJECT = 'cc568-project';

async function cleanup() {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

describe('CreditCardService — reimportar fatura após soft-delete não recria a despesa (#568)', () => {
  let service: CreditCardService;
  let cardId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanup();
    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Cartão dedupe soft-delete tenant' } });
    await setupPrisma.project.create({
      data: { id: PROJECT, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
    });
    service = new CreditCardService(
      prisma,
      new ConciliacaoService(prisma),
      new MerchantClassifierService(prisma),
    );
    const card = await service.createCard(TENANT, PROJECT, {
      institution: 'ITAU',
      brand: 'Visa',
      nickname: 'Itaú Click',
      last4: '9911',
    } as any);
    cardId = card.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  const faturaCsv = `data;descricao;valor
10/06/2026;MERCADO ABC;R$ 100,00
`;

  it('NÃO recria a despesa: findExistingExternalIds enxerga soft-deletados', async () => {
    // 1ª importação: cria a despesa.
    const r1 = await service.commitImport(
      TENANT, PROJECT, cardId, faturaCsv, 'itau-fatura-06.csv', 'AUTO' as any,
      undefined, undefined, undefined, null, TEST_OWNER_REQUESTER,
    );
    expect(r1.inserted).toBe(1);
    expect(r1.duplicated).toBe(0);

    const created = await setupPrisma.expense.findFirst({
      where: { tenantId: TENANT, projectId: PROJECT, cardLast4: '9911' },
    });
    expect(created).toBeTruthy();
    expect(created!.deletedAt).toBeNull();

    // Usuário exclui a despesa na UI: soft-delete real (deletedAt=now), a
    // linha continua fisicamente na tabela.
    await setupPrisma.expense.update({
      where: { id: created!.id },
      data: { deletedAt: new Date() },
    });

    // 2ª importação: MESMA fatura — a despesa excluída NÃO deve voltar.
    const r2 = await service.commitImport(
      TENANT, PROJECT, cardId, faturaCsv, 'itau-fatura-06.csv', 'AUTO' as any,
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
      where: { tenantId: TENANT, projectId: PROJECT, cardLast4: '9911' },
    });
    expect(all).toHaveLength(1);
    expect(all[0].deletedAt).not.toBeNull();
  });
});
