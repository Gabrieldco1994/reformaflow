/**
 * #568 (M6) — paridade de contagem de duplicatas no `commitImport` da fatura de
 * cartão com o padrão já consolidado do lado CONTA
 * (`bank-account/__tests__/commit-import-dedup.spec.ts`).
 *
 * O M4 (linha soft-deletada ressuscitava — `findExistingExternalIds` via
 * `$queryRaw`) já foi portado pelo PR #623 e é coberto por
 * `commit-import-softdelete-dedupe.spec.ts`. Resta o M6: o cálculo de
 * `duplicated` subtraía TODAS as `decisions` com `action:'skip'`, mas uma linha
 * que é duplicata-contra-histórico (`existingIds.has` = true) E carrega
 * `action:'skip'` já foi removida de `toProcess` pelas duas condições — subtraí-la
 * de novo por `decisions.filter(skip).length` derruba `duplicated` abaixo do real
 * e some do relatório inteiro (`total !== inserted + duplicated + skipped`).
 * O filtro de `duplicatedItems` tinha o espelho do mesmo bug: descartava a linha
 * por `d?.action === 'skip'` sem checar `existingIds.has`.
 *
 * Banco real descartável (prisma/test.db do worktree). A trava de banco
 * (test-db-env) precisa vir ANTES de qualquer import do Prisma.
 * As asserções são só de CONTAGEM (nenhuma filtra por "mês corrente"), então
 * não há necessidade de congelar o relógio (regra #22) — ainda assim a suíte
 * roda com `TZ=UTC`.
 */
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

const TENANT = 'cc568-m6-tenant';
const PROJECT = 'cc568-m6-project';

let service: CreditCardService;
let cardId: string;

async function cleanup() {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

/** Zera só as linhas que cada cenário produz — tenant/projeto/cartão sobrevivem. */
async function resetData() {
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
}

function commit(csv: string, decisions?: any[]) {
  return service.commitImport(
    TENANT, PROJECT, cardId, csv, 'itau-fatura.csv', 'AUTO' as any,
    undefined, undefined, decisions, null, TEST_OWNER_REQUESTER,
  );
}

/** Invariante central: nenhuma linha some — todo balde terminal soma o total. */
function expectReconciles(res: any) {
  expect(res.total).toBe(res.inserted + res.duplicated + res.skipped + (res.settled ?? 0));
}

beforeAll(async () => {
  await setupPrisma.$connect();
  await prisma.onModuleInit();
  await cleanup();
  await setupPrisma.tenant.create({ data: { id: TENANT, name: 'Cartão M6 tenant' } });
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
    last4: '5568',
  } as any);
  cardId = card.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.onModuleDestroy();
  await setupPrisma.$disconnect();
});

describe('CreditCardService.commitImport — linha duplicada-contra-histórico E marcada skip pelo usuário (#568 M6)', () => {
  let res2: any;
  let mercadoExternalId: string;

  beforeAll(async () => {
    await resetData();

    // 1ª importação: cria a despesa "MERCADO ABC".
    const r1 = await commit(`data;descricao;valor
10/06/2026;MERCADO ABC;R$ 100,00
`);
    expect(r1.inserted).toBe(1);

    const mercado = await setupPrisma.expense.findFirst({
      where: { tenantId: TENANT, projectId: PROJECT, cardLast4: '5568' },
    });
    mercadoExternalId = mercado!.externalId!;

    // 2ª importação: MERCADO ABC volta (duplicata contra histórico) + PADARIA XYZ
    // (nova). O usuário ainda marca a linha duplicada como `skip` no preview —
    // é a combinação que fazia a linha sumir do relatório.
    res2 = await commit(`data;descricao;valor
10/06/2026;MERCADO ABC;R$ 100,00
12/06/2026;PADARIA XYZ;R$ 50,00
`, [{ externalId: mercadoExternalId, action: 'skip' }]);
  });

  it('M6a: a linha duplicada-e-marcada-skip conta como duplicata e o total reconcilia', () => {
    expect(res2.total).toBe(2);
    expect(res2.inserted).toBe(1); // só PADARIA XYZ
    expect(res2.duplicated).toBe(1); // baseline: 0 (subtraída duas vezes)
    expectReconciles(res2); // baseline: 2 !== 1 + 0 + 0 + 0
  });

  it('M6b: a linha aparece itemizada em duplicatedItems', () => {
    expect(res2.duplicatedItems).toHaveLength(1); // baseline: []
    expect(res2.duplicatedItems[0]).toMatchObject({
      externalId: mercadoExternalId,
      description: 'MERCADO ABC',
      amountCents: 10000,
      reason: 'duplicate',
    });
  });
});

describe('CreditCardService.commitImport — regressões de contagem (não devem mudar com o fix do M6)', () => {
  it('skip em linha NOVA: entra pelo balde userSkipped, não some nem vira duplicata', async () => {
    await resetData();
    const csv = `data;descricao;valor
10/06/2026;LOJA A;R$ 100,00
12/06/2026;LOJA B;R$ 50,00
`;
    const preview = await service.previewImport(
      TENANT, PROJECT, cardId, csv, 'itau-fatura.csv', 'AUTO' as any, undefined, TEST_OWNER_REQUESTER,
    );
    const lojaA = preview.preview.find((p: any) => /LOJA A/.test(p.merchant));
    expect(lojaA).toBeDefined();

    const res = await commit(csv, [{ externalId: lojaA!.externalId, action: 'skip' }]);
    expect(res.total).toBe(2);
    expect(res.inserted).toBe(1); // LOJA B
    expect(res.skipped).toBe(1); // LOJA A — skip do usuário em linha nova
    expect(res.duplicated).toBe(0);
    expect(res.duplicatedItems).toHaveLength(0);
    expectReconciles(res);
  });

  it('reimport do MESMO arquivo sem decisions: inserted 0, duplicated N, tudo itemizado', async () => {
    // O ângulo soft-delete está em commit-import-softdelete-dedupe.spec.ts; aqui
    // a asserção é a reconciliação do total no reimport puro.
    await resetData();
    const csv = `data;descricao;valor
10/06/2026;LOJA C;R$ 100,00
12/06/2026;LOJA D;R$ 50,00
`;
    const r1 = await commit(csv);
    expect(r1.inserted).toBe(2);

    const r2 = await commit(csv);
    expect(r2.total).toBe(2);
    expect(r2.inserted).toBe(0);
    expect(r2.duplicated).toBe(2);
    expect(r2.duplicatedItems).toHaveLength(2);
    expectReconciles(r2);
  });
});
