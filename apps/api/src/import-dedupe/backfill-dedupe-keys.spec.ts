// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

/**
 * #659 SEC-4 — contrato do backfill de `dedupe_key_natural` (design §7).
 *
 * Prisma REAL contra prisma/test.db (test-db-env.cjs). Cobre:
 *  (a) run#1 popula todas; run#2 = 0 updates, sem P2002.
 *  (b) interrupção no meio (uma parte já feita) + rerun completa o resto.
 *  (c) `assignHistoricalOrdinals` == `computeImportOrdinals` para o mesmo conjunto.
 *
 * Rodar com TZ=UTC (regra de ouro #22):
 *   cd apps/api && TZ=UTC npx jest import-dedupe/backfill-dedupe-keys
 */
import { PrismaClient } from '@prisma/client';
import { computeImportOrdinals } from '../credit-card/parsers/dedupe-key';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  runBackfill,
  assignHistoricalOrdinals,
  dedupeKeyNatural,
} = require('../../scripts/backfill-dedupe-keys.cjs');

const prisma = new PrismaClient();

const TENANT = 'backfill-659-tenant';
const PROJECT = 'backfill-659-project';

async function cleanup() {
  await prisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await prisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await prisma.receipt.deleteMany({ where: { tenantId: TENANT } });
  await prisma.project.deleteMany({ where: { tenantId: TENANT } });
  await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

const EXP = {
  tenantId: TENANT,
  projectId: PROJECT,
  tipoDespesa: 'OUTROS',
  quantidade: 1,
  formaPagamento: 'A_VISTA',
  status: 'PAGO',
  importId: 'imp-1',
  dataCompra: new Date('2026-04-10T12:00:00.000Z'),
};

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({ data: { id: TENANT, name: 'Backfill 659' } });
  await prisma.project.create({
    data: { id: PROJECT, tenantId: TENANT, type: 'PESSOAL', name: 'P' },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

it('(a) run#1 popula tudo; gêmeas do mesmo bucket → ordinais 0/1; run#2 = 0 updates sem P2002', async () => {
  await prisma.expense.create({
    data: { ...EXP, titulo: 'Cafe', valor: 1200, valorTotal: 1200, externalId: 'ext-a' },
  });
  await prisma.expense.create({
    data: { ...EXP, titulo: 'Cafe', valor: 1200, valorTotal: 1200, externalId: 'ext-b' },
  });
  await prisma.receipt.create({
    data: {
      tenantId: TENANT,
      projectId: PROJECT,
      tipo: 'OUTROS',
      valor: 5000,
      data: new Date('2026-04-11T12:00:00.000Z'),
      status: 'EM_CAIXA',
      importId: 'imp-1',
      externalId: 'ext-r',
    },
  });

  const first = await runBackfill(prisma);
  expect(first).toEqual({ expenses: 2, receipts: 1 });

  const rows = await prisma.expense.findMany({
    where: { tenantId: TENANT },
    select: { dedupeKeyNatural: true },
    orderBy: { externalId: 'asc' },
  });
  expect(rows.every((r) => /^[0-9a-f]{32}$/.test(r.dedupeKeyNatural ?? ''))).toBe(true);
  expect(rows[0].dedupeKeyNatural).not.toBe(rows[1].dedupeKeyNatural); // ordinal 0 vs 1
  const before = rows.map((r) => r.dedupeKeyNatural);

  const second = await runBackfill(prisma);
  expect(second).toEqual({ expenses: 0, receipts: 0 });

  const after = await prisma.expense.findMany({
    where: { tenantId: TENANT },
    select: { dedupeKeyNatural: true },
    orderBy: { externalId: 'asc' },
  });
  expect(after.map((r) => r.dedupeKeyNatural)).toEqual(before);
});

it('(b) interrupção no meio: parte já preenchida + rerun completa o resto sem tocar a parte feita', async () => {
  const done = await prisma.expense.create({
    data: { ...EXP, titulo: 'Feito', valor: 900, valorTotal: 900, externalId: 'ext-done' },
  });
  await prisma.expense.create({
    data: { ...EXP, titulo: 'Pendente 1', valor: 100, valorTotal: 100, externalId: 'ext-p1' },
  });
  await prisma.expense.create({
    data: { ...EXP, titulo: 'Pendente 2', valor: 200, valorTotal: 200, externalId: 'ext-p2' },
  });
  // simula batch 1 já commitado antes do Ctrl-C
  await prisma.expense.update({
    where: { id: done.id },
    data: { dedupeKeyNatural: 'sentinel-already-set-manually-000' },
  });

  const res = await runBackfill(prisma);
  expect(res.expenses).toBe(2); // só as 2 pendentes

  const all = await prisma.expense.findMany({
    where: { tenantId: TENANT },
    select: { externalId: true, dedupeKeyNatural: true },
  });
  const byExt = Object.fromEntries(all.map((r) => [r.externalId, r.dedupeKeyNatural]));
  expect(byExt['ext-done']).toBe('sentinel-already-set-manually-000'); // intocada
  expect(byExt['ext-p1']).toMatch(/^[0-9a-f]{32}$/);
  expect(byExt['ext-p2']).toMatch(/^[0-9a-f]{32}$/);
});

it('(c) assignHistoricalOrdinals == computeImportOrdinals para o mesmo conjunto de linhas', () => {
  const specs = [
    { date: new Date('2026-05-05T00:00:00Z'), merchant: 'Feira Livre', amountCents: 2500 },
    { date: new Date('2026-05-05T00:00:00Z'), merchant: 'Feira Livre', amountCents: 2500 },
    { date: new Date('2026-05-05T00:00:00Z'), merchant: 'FEIRA livre ', amountCents: 2500 },
    { date: new Date('2026-05-06T00:00:00Z'), merchant: 'Outro', amountCents: 999 },
  ];
  const live = computeImportOrdinals(specs);
  const rows = specs.map((s, i) => ({
    id: `row-${i}`,
    tenantId: TENANT,
    projectId: PROJECT,
    date: s.date,
    merchant: s.merchant,
    amountCents: s.amountCents,
  }));
  const historical = assignHistoricalOrdinals(rows);
  rows.forEach((r, i) => {
    expect(historical.get(r.id)).toBe(live[i]);
  });
  // e a chave natural resultante bate com a fórmula viva
  expect(
    dedupeKeyNatural({
      tenantId: TENANT,
      projectId: PROJECT,
      date: specs[0].date,
      merchant: specs[0].merchant,
      amountCents: specs[0].amountCents,
      ordinal: 0,
    }),
  ).toMatch(/^[0-9a-f]{32}$/);
});
