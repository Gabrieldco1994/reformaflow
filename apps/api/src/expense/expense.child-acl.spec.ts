/**
 * B1a (#448) — child ACL nas ações expostas de rateio/vínculo/settlement.
 * Autorado RED contra o baseline pré-#448 (389d8e6e); GREEN após a
 * implementação (verificado em test/b1a-child-acl-postbuild, a029a6cf) —
 * mantido como regression lock, agora chamando os métodos REAIS (sem cast
 * `as any`): a implementação passou a declarar `requester?: RateioRequester`
 * como último parâmetro em `linkToExpense`/`linkCrossProject`/`create`/
 * `conciliarParcela`/`ratear`/`ratearMixed`, então o compilador agora valida
 * de verdade a forma do requester em cada chamada abaixo.
 *
 * Contrato (issue #448, B1a): "Child ACL aplicada a link, rateio, settlement,
 * pay/undo, roomId e sourcePriceItemId; reler no commit." + STATUS CONTRACT do
 * dispatch: parent same-tenant fora do scope → 403 (coberto em B0/#447, não
 * repetido aqui); child hidden/cross-tenant/missing colapsa no MESMO status já
 * usado por cada rota para "não encontrado" — 404 para link/conciliar, 400
 * para linkCrossProject/resolveLinks/rateio (contrato PRÉ-EXISTENTE, preservado)
 * — e nunca revela a diferença entre hidden/cross-tenant/realmente-inexistente.
 *
 * No baseline pré-#448, NENHUMA das mutações abaixo recebia ou consultava um
 * `requester`: elas só filtravam por `tenantId`, então um alvo em outro
 * projeto do MESMO tenant (fora do allowedProjects do requester) passava
 * livremente. Este arquivo materializa o contrato usando Prisma REAL (SQLite
 * descartável) — sem mocks que espelhem a lógica do service.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { CreditCardService } from '../credit-card/credit-card.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import { RateioRequester } from './rateio.types';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'eacl-tenant';
const TENANT_OTHER = 'eacl-tenant-other';
const PESSOAL = 'eacl-pessoal';       // projeto fonte, sempre no scope do requester
const ALLOWED = 'eacl-allowed';       // outro projeto do MESMO tenant, no scope
const HIDDEN = 'eacl-hidden';         // outro projeto do MESMO tenant, FORA do scope
const OTHER_TENANT_PROJECT = 'eacl-other-tenant-project';

const MANAGED: RateioRequester = {
  role: 'USER',
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};
const ADMIN: RateioRequester = { role: 'ADMIN', allowedProjects: [], allowedProjectTypes: [], allowedModules: [] };

async function cleanupTransient() {
  await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
}

async function cleanupAll() {
  await cleanupTransient();
  await setupPrisma.creditCard.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.project.deleteMany({ where: { tenantId: { in: [TENANT, TENANT_OTHER] } } });
  await setupPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, TENANT_OTHER] } } });
}

const T0 = new Date('2026-08-10T12:00:00.000Z');

function baseExpense(over: Record<string, unknown>): any {
  return {
    tenantId: TENANT,
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valor: 10_000,
    quantidade: 1,
    valorTotal: 10_000,
    titulo: 'Item',
    formaPagamento: 'A_VISTA',
    dataPagamento: T0,
    status: 'PLANEJADO',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe('ExpenseService/CreditCardService — child ACL real DB (#448 B1a)', () => {
  let expenseService: ExpenseService;
  let cardService: CreditCardService;
  let cardId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();

    await setupPrisma.tenant.createMany({
      data: [
        { id: TENANT, name: 'Child ACL tenant' },
        { id: TENANT_OTHER, name: 'Child ACL outro tenant' },
      ],
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
        { id: ALLOWED, tenantId: TENANT, type: 'REFORMA', name: 'Reforma autorizada' },
        { id: HIDDEN, tenantId: TENANT, type: 'CASA', name: 'Casa oculta' },
        { id: OTHER_TENANT_PROJECT, tenantId: TENANT_OTHER, type: 'PESSOAL', name: 'Pessoal outro tenant' },
      ],
    });
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT, projectId: PESSOAL, institution: 'ITAU', brand: 'Visa',
        nickname: 'Cartão fonte', last4: '4444',
      },
    });
    cardId = card.id;

    expenseService = new ExpenseService(prisma, new ConciliacaoService(prisma));
    cardService = new CreditCardService(
      prisma,
      new ConciliacaoService(prisma),
      new MerchantClassifierService(prisma),
    );
  });

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  afterEach(async () => {
    await cleanupTransient();
  });

  /** Fonte importada do cartão (PESSOAL), pronta para linkToExpense. */
  async function makeCardSource(titulo: string) {
    return setupPrisma.expense.create({
      data: baseExpense({
        projectId: PESSOAL, titulo, cardLast4: '4444', origin: 'import',
        valorTotal: 20_000, valor: 20_000,
      }),
    });
  }

  async function makeTarget(projectId: string, titulo: string, tenantId = TENANT) {
    return setupPrisma.expense.create({
      data: baseExpense({ tenantId, projectId, titulo, valorTotal: 20_000, valor: 20_000 }),
    });
  }

  // ── linkToExpense (Cartões → Vincular) ──────────────────────────────────

  describe('linkToExpense (credit-card.service)', () => {
    it('alvo em projeto do MESMO tenant fora do scope (hidden) → 404, zero writes', async () => {
      const source = await makeCardSource('src-hidden');
      const target = await makeTarget(HIDDEN, 'tgt-hidden');

      await expect(
        cardService.linkToExpense(TENANT, PESSOAL, source.id, target.id, {}, MANAGED),
      ).rejects.toBeInstanceOf(NotFoundException);

      const settlement = await setupPrisma.crossProjectSettlement.findFirst({ where: { targetExpenseId: target.id } });
      expect(settlement).toBeNull();
      const sourceRow = await setupPrisma.expense.findUnique({ where: { id: source.id } });
      expect(sourceRow?.linkedExpenseId).toBeNull();
    });

    it('alvo em OUTRO tenant → 404 com a MESMA mensagem do hidden (indistinguível)', async () => {
      const source = await makeCardSource('src-cross-tenant');
      const target = await makeTarget(OTHER_TENANT_PROJECT, 'tgt-cross-tenant', TENANT_OTHER);
      const hiddenTarget = await makeTarget(HIDDEN, 'tgt-hidden-2');

      let hiddenError: unknown;
      let crossTenantError: unknown;
      try {
        await cardService.linkToExpense(TENANT, PESSOAL, source.id, hiddenTarget.id, {}, MANAGED);
      } catch (e) { hiddenError = e; }
      try {
        await cardService.linkToExpense(TENANT, PESSOAL, source.id, target.id, {}, MANAGED);
      } catch (e) { crossTenantError = e; }

      expect(crossTenantError).toBeInstanceOf(NotFoundException);
      expect(hiddenError).toBeInstanceOf(NotFoundException);
      expect((crossTenantError as NotFoundException)?.message).toBe((hiddenError as NotFoundException)?.message);

      const settlement = await setupPrisma.crossProjectSettlement.findFirst({ where: { targetExpenseId: target.id } });
      expect(settlement).toBeNull();
    });

    it('alvo em projeto AUTORIZADO (allowed) → sucesso (controle)', async () => {
      const source = await makeCardSource('src-allowed');
      const target = await makeTarget(ALLOWED, 'tgt-allowed');

      const result = await cardService.linkToExpense(TENANT, PESSOAL, source.id, target.id, {}, MANAGED);
      expect(result.ok).toBe(true);

      const settlement = await setupPrisma.crossProjectSettlement.findFirst({ where: { targetExpenseId: target.id } });
      expect(settlement).not.toBeNull();
      expect(settlement?.sourceExpenseId).toBe(source.id);
    });
  });

  // ── linkCrossProject (contrato existente: 400, não 404) ─────────────────

  describe('linkCrossProject', () => {
    it('alvo hidden (mesmo tenant, fora do scope) → 400 (contrato existente), zero writes', async () => {
      const source = await makeCardSource('lcp-src-hidden');
      const target = await makeTarget(HIDDEN, 'lcp-tgt-hidden');

      await expect(
        expenseService.linkCrossProject(TENANT, PESSOAL, source.id, target.id, MANAGED),
      ).rejects.toBeInstanceOf(BadRequestException);

      const sourceRow = await setupPrisma.expense.findUnique({ where: { id: source.id } });
      expect(sourceRow?.linkedExpenseId).toBeNull();
    });

    it('alvo em outro tenant → 400 idêntico ao hidden (indistinguível)', async () => {
      const source = await makeCardSource('lcp-src-cross');
      const target = await makeTarget(OTHER_TENANT_PROJECT, 'lcp-tgt-cross', TENANT_OTHER);
      const hiddenTarget = await makeTarget(HIDDEN, 'lcp-tgt-hidden-2');

      let hiddenErr: unknown; let crossErr: unknown;
      try { await expenseService.linkCrossProject(TENANT, PESSOAL, source.id, hiddenTarget.id, MANAGED); } catch (e) { hiddenErr = e; }
      try { await expenseService.linkCrossProject(TENANT, PESSOAL, source.id, target.id, MANAGED); } catch (e) { crossErr = e; }

      expect(hiddenErr).toBeInstanceOf(BadRequestException);
      expect(crossErr).toBeInstanceOf(BadRequestException);
      expect((hiddenErr as BadRequestException).message).toBe((crossErr as BadRequestException).message);
    });

    it('alvo allowed → sucesso (controle)', async () => {
      const source = await makeCardSource('lcp-src-allowed');
      const target = await makeTarget(ALLOWED, 'lcp-tgt-allowed');

      const updated = await expenseService.linkCrossProject(TENANT, PESSOAL, source.id, target.id, MANAGED);
      expect(updated.linkedExpenseId).toBe(target.id);
    });

    it('ADMIN não é bloqueado pelo guard de child ACL (controle de papel)', async () => {
      const source = await makeCardSource('lcp-src-admin');
      const target = await makeTarget(HIDDEN, 'lcp-tgt-admin-hidden');

      const updated = await expenseService.linkCrossProject(TENANT, PESSOAL, source.id, target.id, ADMIN);
      expect(updated.linkedExpenseId).toBe(target.id);
    });
  });

  // ── resolveLinks (via create/update, campo linkedExpenseId) ─────────────

  describe('resolveLinks — linkedExpenseId em create/update', () => {
    const baseDto = () => ({
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 50,
      quantidade: 1,
      titulo: 'Compra com vínculo',
      formaPagamento: 'A_VISTA',
      status: 'PLANEJADO',
    });

    it('create com linkedExpenseId hidden → 400, nenhuma despesa criada', async () => {
      const target = await makeTarget(HIDDEN, 'rl-tgt-hidden');
      const before = await setupPrisma.expense.count({ where: { tenantId: TENANT, projectId: PESSOAL } });

      await expect(
        expenseService.create(TENANT, PESSOAL, { ...baseDto(), linkedExpenseId: target.id }, null, undefined, MANAGED),
      ).rejects.toBeInstanceOf(BadRequestException);

      const after = await setupPrisma.expense.count({ where: { tenantId: TENANT, projectId: PESSOAL } });
      expect(after).toBe(before);
    });

    it('create com linkedExpenseId allowed → sucesso (controle)', async () => {
      const target = await makeTarget(ALLOWED, 'rl-tgt-allowed');
      const created = await expenseService.create(
        TENANT, PESSOAL, { ...baseDto(), linkedExpenseId: target.id }, null, undefined, MANAGED,
      );
      expect(created.linkedExpenseId).toBe(target.id);
    });
  });

  // ── conciliarParcela (contrato existente: 404) ──────────────────────────

  describe('conciliarParcela', () => {
    it('alvo hidden → 404, zero writes (target permanece PLANEJADO)', async () => {
      const source = await makeCardSource('cp-src-hidden');
      const target = await makeTarget(HIDDEN, 'cp-tgt-hidden');

      await expect(
        expenseService.conciliarParcela(
          TENANT, PESSOAL, source.id, { targetExpenseId: target.id }, MANAGED,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      const targetRow = await setupPrisma.expense.findUnique({ where: { id: target.id } });
      expect(targetRow?.status).toBe('PLANEJADO');
      const settlement = await setupPrisma.crossProjectSettlement.findFirst({ where: { targetExpenseId: target.id } });
      expect(settlement).toBeNull();
    });

    it('alvo allowed → sucesso (controle), target vira PAGO', async () => {
      const source = await makeCardSource('cp-src-allowed');
      const target = await makeTarget(ALLOWED, 'cp-tgt-allowed');

      await expenseService.conciliarParcela(
        TENANT, PESSOAL, source.id, { targetExpenseId: target.id }, MANAGED,
      );
      const targetRow = await setupPrisma.expense.findUnique({ where: { id: target.id } });
      expect(targetRow?.status).toBe('PAGO');
    });
  });

  // ── ratear / ratearMixed (contrato existente: 400) ──────────────────────

  describe('ratear', () => {
    it('alocação para alvo hidden → 400, zero writes (nenhuma RateioAllocation criada)', async () => {
      const source = await makeCardSource('rt-src-hidden');
      const target = await makeTarget(HIDDEN, 'rt-tgt-hidden');

      await expect(
        expenseService.ratear(
          TENANT, PESSOAL, source.id,
          [{ targetExpenseId: target.id, allocation: 20_000 }],
          MANAGED,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const allocCount = await setupPrisma.rateioAllocation.count({ where: { sourceExpenseId: source.id } });
      expect(allocCount).toBe(0);
    });

    it('alocação para alvo allowed → sucesso (controle)', async () => {
      const source = await makeCardSource('rt-src-allowed');
      const target = await makeTarget(ALLOWED, 'rt-tgt-allowed');

      const result = await expenseService.ratear(
        TENANT, PESSOAL, source.id,
        [{ targetExpenseId: target.id, allocation: 20_000 }],
        MANAGED,
      );
      expect(result.targets).toEqual([target.id]);
    });
  });

  describe('ratearMixed — rollback transacional completo', () => {
    it('1 alvo NOVO válido + 1 alvo EXISTENTE hidden → 400 e o alvo novo NÃO fica órfão (rollback total)', async () => {
      const source = await makeCardSource('rtm-src');
      const hiddenExisting = await makeTarget(HIDDEN, 'rtm-tgt-hidden');
      const marker = 'rtm-novo-orfao-marker';

      await expect(
        expenseService.ratearMixed(
          TENANT, PESSOAL, source.id,
          {
            newTargets: [{
              targetProjectId: ALLOWED,
              tipoDespesa: 'MATERIAL_CONSTRUCAO',
              valor: 100,
              titulo: marker,
              allocation: 10_000,
            }],
            existing: [{ targetExpenseId: hiddenExisting.id, allocation: 10_000 }],
          },
          null,
          MANAGED,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const orphan = await setupPrisma.expense.findFirst({ where: { tenantId: TENANT, titulo: marker } });
      expect(orphan).toBeNull();
      const allocCount = await setupPrisma.rateioAllocation.count({ where: { sourceExpenseId: source.id } });
      expect(allocCount).toBe(0);
    });

    it('2 alvos NOVOS válidos (allowed) → sucesso, ambos persistidos e rateados (controle)', async () => {
      const source = await makeCardSource('rtm-src-ok');

      const result = await expenseService.ratearMixed(
        TENANT, PESSOAL, source.id,
        {
          newTargets: [
            { targetProjectId: ALLOWED, tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 100, titulo: 'rtm-ok-1', allocation: 10_000 },
            { targetProjectId: ALLOWED, tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: 100, titulo: 'rtm-ok-2', allocation: 10_000 },
          ],
          existing: [],
        },
        null,
        MANAGED,
      );
      expect(result.createdTargetIds).toHaveLength(2);
      const allocCount = await setupPrisma.rateioAllocation.count({ where: { sourceExpenseId: source.id } });
      expect(allocCount).toBe(2);
    });
  });
});
