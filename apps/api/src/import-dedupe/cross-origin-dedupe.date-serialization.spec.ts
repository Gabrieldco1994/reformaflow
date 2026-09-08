// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

/**
 * Regressão de serialização de data no payload `possibleDuplicate` (#680 review).
 *
 * Bug reproduzido pelo coordenador: no SELECT de `expenses` o
 * `COALESCE(data_compra, data_pagamento, data_inicio_parcela, created_at)`
 * perde a inferência de tipo no `$queryRaw` do SQLite e o Prisma devolve o
 * DATETIME como **bigint em milissegundos** (`1781049600000n`). O `toIso`
 * antigo não tratava `bigint` e caía em `String(v).slice(0,10)` → `"1781049600"`.
 * `receipts.data` (coluna direta) volta como `Date` e serializava certo.
 *
 * Este spec chama `findDedupeMatches` DIRETO com Prisma real: cria uma linha
 * com cada fallback do COALESCE e confere `existingDate === '2026-06-10'`
 * literal, além de identidade/valor/motivo do match preservados.
 *
 * Rodar com TZ=UTC (regra de ouro #22).
 */
import { PrismaClient } from '@prisma/client';
import {
  findDedupeMatches,
  POSSIBLE_DUPLICATE_REASON,
} from './cross-origin-dedupe';

const prisma = new PrismaClient();

const TENANT = 'dupdate-tenant';
const PROJECT = 'dupdate-project';
/** 2026-06-10T00:00:00.000Z — midnight UTC, conforme docs/politica-datas-timezone.md. */
const DAY = new Date('2026-06-10T00:00:00.000Z');
const EXPECTED_ISO = '2026-06-10';

/** natural key arbitrária — o matching é igualdade de string. */
let seq = 0;
function natKey(): string {
  seq += 1;
  return `dupdate-nat-${seq}`;
}

async function cleanup() {
  await prisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await prisma.receipt.deleteMany({ where: { tenantId: TENANT } });
  await prisma.project.deleteMany({ where: { tenantId: TENANT } });
  await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanup();
  await prisma.tenant.create({ data: { id: TENANT, name: 'Dupdate' } });
  await prisma.project.create({
    data: { id: PROJECT, tenantId: TENANT, type: 'PESSOAL', name: 'Proj' },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await prisma.receipt.deleteMany({ where: { tenantId: TENANT } });
});

interface ExpenseDateShape {
  dataCompra?: Date | null;
  dataPagamento?: Date | null;
  dataInicioParcela?: Date | null;
  createdAt?: Date;
}

async function createExpense(dates: ExpenseDateShape, natural: string) {
  return prisma.expense.create({
    data: {
      tenantId: TENANT,
      projectId: PROJECT,
      tipoDespesa: 'OUTROS',
      valor: 4200,
      quantidade: 1,
      valorTotal: 4200,
      formaPagamento: 'A_VISTA',
      status: 'PAGO',
      externalId: `existing-${natural}`,
      dedupeKeyStrong: null,
      dedupeKeyNatural: natural,
      dataCompra: dates.dataCompra ?? null,
      dataPagamento: dates.dataPagamento ?? null,
      dataInicioParcela: dates.dataInicioParcela ?? null,
      ...(dates.createdAt ? { createdAt: dates.createdAt } : {}),
    },
  });
}

async function matchFor(natural: string) {
  const res = await findDedupeMatches(prisma, TENANT, PROJECT, [
    { externalId: `batch-${natural}`, strong: null, natural },
  ]);
  return res.possibleDuplicates.get(`batch-${natural}`);
}

describe('findDedupeMatches — serialização de existingDate (#680 review)', () => {
  const fallbacks: Array<[string, () => ExpenseDateShape]> = [
    ['data_compra', () => ({ dataCompra: DAY })],
    ['data_pagamento', () => ({ dataPagamento: DAY })],
    ['data_inicio_parcela', () => ({ dataInicioParcela: DAY })],
    ['created_at (todos os outros null)', () => ({ createdAt: DAY })],
  ];

  for (const [label, shape] of fallbacks) {
    it(`Expense via COALESCE ${label}: existingDate === "${EXPECTED_ISO}"`, async () => {
      const natural = natKey();
      const created = await createExpense(shape(), natural);

      const hit = await matchFor(natural);

      expect(hit).toBeDefined();
      expect(hit!.existingDate).toBe(EXPECTED_ISO);
      // identidade / valor / motivo do match preservados
      expect(hit!.existingId).toBe(created.id);
      expect(hit!.existingAmountCents).toBe(4200);
      expect(hit!.reason).toBe(POSSIBLE_DUPLICATE_REASON);
      expect(hit!.externalId).toBe(`batch-${natural}`);
    });
  }

  it('Receipt (coluna data direta) — controle: existingDate === "2026-06-10"', async () => {
    const natural = natKey();
    const created = await prisma.receipt.create({
      data: {
        tenantId: TENANT,
        projectId: PROJECT,
        tipo: 'OUTROS',
        descricao: 'Controle',
        valor: 4200,
        data: DAY,
        origin: 'none',
        externalId: `existing-${natural}`,
        dedupeKeyStrong: null,
        dedupeKeyNatural: natural,
      },
    });

    const hit = await matchFor(natural);

    expect(hit).toBeDefined();
    expect(hit!.existingDate).toBe(EXPECTED_ISO);
    expect(hit!.existingId).toBe(created.id);
    expect(hit!.existingAmountCents).toBe(4200);
  });

  it('sem linha correspondente → nenhum possibleDuplicate (falha se casar por engano)', async () => {
    const hit = await matchFor(natKey());
    expect(hit).toBeUndefined();
  });
});
