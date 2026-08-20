/**
 * B1b (#448, PR 3/3) — endurecimento do legado: o rateio parcial vira
 * SOURCE-ONLY.
 *
 * Contrato novo (issue #448, seção B1b + `docs/plano-centro-financeiro-sdd.md`
 * §4.2 "CONTRATO FUTURO APROVADO PARA #436"):
 *  - "Hidden count/sum são removidos da resposta; comparação deep-equal do
 *     payload redigido é idêntica a uma resposta vazia/sem metadata."
 *  - "Rateio parcial não revela relação/count/soma/flag/metadata."
 *
 * TUDO-OU-NADA, não lista filtrada. `docs/plano-centro-financeiro-sdd.md`
 * §4.2: "só substituem a fonte quando TODOS os participantes do rateio estão
 * autorizados e a soma fecha exatamente. Caso contrário, retornam source-only,
 * sem flag, contagem, soma, metadata ou qualquer inferência sobre participantes
 * ocultos."
 *
 * POR QUE LISTA FILTRADA NÃO FECHA O VAZAMENTO (aritmética, não estilo):
 * `conciliacao.service.ts:705` RECUSA a escrita quando
 * `Σ alocações !== source.valorTotal`. O invariante é imposto na criação, logo,
 * num payload que traga a lista parcial E um número derivado do total:
 *
 *     sobraCents = totalSourceCents − Σ(itens visíveis) = Σ(alocações ocultas)
 *
 * Igualdade EXATA. O vazamento apenas troca de nome: sai do campo
 * `hiddenAllocationCents` e volta como campo calculado. Nenhuma escolha de
 * `rateadoCents` conserta isso — qualquer payload com lista parcial + número
 * derivado do total permite a subtração. Por isso o contrato é source-only.
 *
 * ORÁCULO CORRETO (o antigo estava errado e este teste é o conserto): comparar
 * o redigido com "a mesma chamada depois de o participante oculto ser
 * hard-deletado" compara DOIS payloads vazados entre si — os dois têm
 * `sobraCents ≠ 0`. O AC pede outra coisa: deep-equal a uma resposta
 * VAZIA/SEM METADATA, isto é, ao payload da MESMA fonte sem NENHUMA alocação.
 *
 * Prisma REAL (SQLite descartável), nunca mock que espelhe a lógica do service.
 */
// O guard do banco de teste precisa carregar ANTES de qualquer import do Prisma.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { RateioRequester } from './rateio.types';

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = 'b1b-rateio-tenant';
const PESSOAL = 'b1b-rateio-pessoal';
const VISIBLE = 'b1b-rateio-visible';
const HIDDEN = 'b1b-rateio-hidden';

const SOURCE = 'b1b-rateio-source';
const TARGET_VISIBLE = 'b1b-rateio-target-visible';
const TARGET_HIDDEN = 'b1b-rateio-target-hidden';

/** Centavos LITERAIS: soma exata 20 000 + 10 029 = 30 029 = valorTotal. */
const TOTAL_CENTS = 30_029;
const VISIBLE_CENTS = 20_000;
const HIDDEN_CENTS = 10_029;

const T0 = new Date('2026-08-10T12:00:00.000Z');
const T1 = new Date('2026-08-10T12:00:01.000Z');

/** Enxerga tudo dentro do tenant. */
const FULL: RateioRequester = {
  role: 'ADMIN',
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};
/** Enxerga o PESSOAL-fonte e o projeto VISIBLE; NUNCA o HIDDEN. */
const PARTIAL: RateioRequester = {
  role: 'USER',
  allowedProjects: [PESSOAL, VISIBLE],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};
/** Enxerga o projeto do ALVO, mas não o PESSOAL onde mora a fonte. */
const TARGET_ONLY: RateioRequester = {
  role: 'USER',
  allowedProjects: [VISIBLE],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};

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

async function cleanupTransient() {
  await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
}

async function cleanupAll() {
  await cleanupTransient();
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

/** Fonte no PESSOAL + dois alvos (um visível, um oculto), rateio somando exato. */
async function seedRateio(options: { hiddenTargetDeleted?: boolean } = {}) {
  await setupPrisma.expense.create({
    data: baseExpense({
      id: SOURCE,
      projectId: PESSOAL,
      titulo: 'Compras TelhaNorte',
      fornecedor: 'TelhaNorte',
      valor: TOTAL_CENTS,
      valorTotal: TOTAL_CENTS,
      status: 'PAGO',
    }),
  });
  await setupPrisma.expense.create({
    data: baseExpense({
      id: TARGET_VISIBLE,
      projectId: VISIBLE,
      titulo: 'Porcelanato sala',
      valor: VISIBLE_CENTS,
      valorTotal: VISIBLE_CENTS,
    }),
  });
  await setupPrisma.expense.create({
    data: baseExpense({
      id: TARGET_HIDDEN,
      projectId: HIDDEN,
      titulo: 'Rejunte da obra do vizinho',
      valor: HIDDEN_CENTS,
      valorTotal: HIDDEN_CENTS,
      deletedAt: options.hiddenTargetDeleted ? T1 : null,
    }),
  });
  await setupPrisma.rateioAllocation.createMany({
    data: [
      {
        tenantId: TENANT,
        sourceExpenseId: SOURCE,
        targetExpenseId: TARGET_VISIBLE,
        allocation: VISIBLE_CENTS,
        plannedValorTotal: VISIBLE_CENTS,
        plannedStatus: 'PLANEJADO',
        createdAt: T0,
      },
      {
        tenantId: TENANT,
        sourceExpenseId: SOURCE,
        targetExpenseId: TARGET_HIDDEN,
        allocation: HIDDEN_CENTS,
        plannedValorTotal: HIDDEN_CENTS,
        plannedStatus: 'PLANEJADO',
        createdAt: T1,
      },
    ],
  });
}

/**
 * Apaga o participante DE VERDADE (hard delete: `RateioAllocation` está em
 * `modelsWithoutSoftDelete`, e o `setupPrisma` é o client cru, sem o `$use`).
 * Usado para montar cenários, NÃO como controle da comparação: um rateio ao
 * qual falta um participante também é um rateio que não fecha a soma.
 */
async function hardDeleteParticipant(targetExpenseId: string) {
  await setupPrisma.rateioAllocation.deleteMany({
    where: { tenantId: TENANT, targetExpenseId },
  });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT, id: targetExpenseId } });
}

/**
 * O CONTROLE do contrato: a mesma fonte, sem NENHUMA alocação — "uma resposta
 * vazia/sem metadata", literalmente uma compra nunca rateada. É contra isto que
 * o payload redigido tem de bater, não contra outra resposta também redigida.
 */
async function hardDeleteEveryAllocation() {
  await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({
    where: { tenantId: TENANT, id: { in: [TARGET_VISIBLE, TARGET_HIDDEN] } },
  });
}

/** Payload canônico de "esta compra não é rateada". */
function neverRateadoPayload(sourceExpenseId: string, totalCents: number) {
  return {
    sourceExpenseId,
    rateado: false,
    totalSourceCents: totalCents,
    rateadoCents: 0,
    sobraCents: totalCents,
    removedTargetsCount: 0,
    items: [],
  };
}

async function allocationSnapshot() {
  return setupPrisma.rateioAllocation.findMany({
    where: { tenantId: TENANT },
    orderBy: [{ sourceExpenseId: 'asc' }, { targetExpenseId: 'asc' }],
  });
}

describe('ExpenseService.getRateio — rateio parcial é source-only (#448 B1b)', () => {
  let service: ExpenseService;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setupPrisma.tenant.create({ data: { id: TENANT, name: 'B1b rateio tenant' } });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: 'PESSOAL', name: 'Pessoal' },
        { id: VISIBLE, tenantId: TENANT, type: 'REFORMA', name: 'Reforma autorizada' },
        { id: HIDDEN, tenantId: TENANT, type: 'REFORMA', name: 'Obra do Vizinho' },
      ],
    });
    service = new ExpenseService(prisma, new ConciliacaoService(prisma));
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it('participante não autorizado: payload redigido é deep-equal ao de uma compra SEM NENHUMA alocação', async () => {
    await seedRateio();

    const redacted = await service.getRateio(TENANT, PESSOAL, SOURCE, PARTIAL);

    // O CONTROLE: a mesma fonte, zero alocações. Não "a mesma chamada com um
    // participante a menos" — aquela também vaza pela sobra.
    await hardDeleteEveryAllocation();
    const semRateio = await service.getRateio(TENANT, PESSOAL, SOURCE, PARTIAL);

    expect(redacted).toEqual(semRateio);
    expect(JSON.stringify(redacted)).toBe(JSON.stringify(semRateio));
    // E o valor literal, para o teste não passar por dois payloads igualmente errados.
    expect(redacted).toEqual(neverRateadoPayload(SOURCE, TOTAL_CENTS));
  });

  it('a sobra NÃO entrega a soma oculta por subtração (o canal aritmético fechado)', async () => {
    await seedRateio();

    const redacted = await service.getRateio(TENANT, PESSOAL, SOURCE, PARTIAL);

    // Com lista filtrada isto valia HIDDEN_CENTS exatos, porque a escrita exige
    // Σ alocações === valorTotal (conciliacao.service.ts:705).
    expect(redacted.totalSourceCents - redacted.rateadoCents).not.toBe(HIDDEN_CENTS);
    expect(redacted.sobraCents).not.toBe(HIDDEN_CENTS);
    // Nenhum item visível sobrevive para servir de minuendo.
    expect(redacted.items).toEqual([]);
  });

  /**
   * A refutação do PO, escrita como código executável em vez de prosa.
   *
   * Um leitor restrito pode rodar este inferidor sobre QUALQUER payload que
   * receba. Sob lista filtrada ele era decisivo, porque:
   *   - a escrita recusa Σ alocações !== valorTotal (conciliacao.service.ts),
   *     logo "dinheiro não alocado" só existe DEPOIS de uma remoção;
   *   - remoção dentro da lente era denunciada por removedTargetsCount;
   *   - portanto removedTargetsCount === 0 ∧ sobraCents > 0 provava que havia
   *     participante fora da lente, e sobraCents era a soma dele em centavos.
   *
   * O contrato só está cumprido se este inferidor devolver o MESMO veredito nos
   * dois mundos — com participante oculto e sem rateio nenhum. Não basta ele
   * "não disparar": basta ele DISCRIMINAR para o sigilo cair.
   */
  const inferirOcultos = (p: Awaited<ReturnType<ExpenseService['getRateio']>>) => ({
    concluiQueHaOcultos: p.removedTargetsCount === 0 && p.sobraCents > 0,
    somaOcultaEstimada: p.sobraCents,
    concluiQueHaRemovidos: p.removedTargetsCount > 0,
  });

  it('o inferidor removedTargetsCount===0 ∧ sobraCents>0 não separa "há oculto" de "nunca rateada"', async () => {
    await seedRateio();
    const comOculto = await service.getRateio(TENANT, PESSOAL, SOURCE, PARTIAL);

    await hardDeleteEveryAllocation();
    const semRateioNenhum = await service.getRateio(TENANT, PESSOAL, SOURCE, PARTIAL);

    // Mesmo veredito nos dois mundos ⇒ o inferidor tem poder de separação ZERO.
    expect(inferirOcultos(comOculto)).toEqual(inferirOcultos(semRateioNenhum));

    // E a estimativa que ele produz sobre a soma oculta está ERRADA: vale o
    // total inteiro, não os centavos que foram para o alvo escondido.
    expect(inferirOcultos(comOculto).somaOcultaEstimada).not.toBe(HIDDEN_CENTS);
    expect(inferirOcultos(comOculto).somaOcultaEstimada).toBe(TOTAL_CENTS);
  });

  it('nenhuma metadata de oculto sobrevive no payload nem na serialização', async () => {
    await seedRateio();

    const redacted = await service.getRateio(TENANT, PESSOAL, SOURCE, PARTIAL);

    // Forma EXATA do contrato: qualquer campo a mais (uma contagem "só pra
    // telemetria", um flag novo) reprova aqui, não só os nomes conhecidos.
    expect(Object.keys(redacted).sort()).toEqual(
      [
        'items',
        'rateado',
        'rateadoCents',
        'removedTargetsCount',
        'sobraCents',
        'sourceExpenseId',
        'totalSourceCents',
      ].sort(),
    );
    const forbiddenKeys = [
      'hiddenTargetsCount',
      'hiddenAllocationCents',
      'hiddenCount',
      'hiddenSum',
      'hiddenTargets',
      'hidden',
    ];
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(redacted, key)).toBe(false);
    }
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(HIDDEN);
    expect(serialized).not.toContain(TARGET_HIDDEN);
    expect(serialized).not.toContain('Obra do Vizinho');
    expect(serialized).not.toContain('Rejunte');
    // Nem o participante VISÍVEL aparece: revelá-lo já contaria que existe um
    // rateio, e a partir daí a sobra conta o resto.
    expect(serialized).not.toContain(TARGET_VISIBLE);
    expect(serialized).not.toContain('Porcelanato');
  });

  it('TODOS os participantes ocultos: mesmo payload source-only, sem flag de relação', async () => {
    await seedRateio();
    await hardDeleteParticipant(TARGET_VISIBLE);

    const redacted = await service.getRateio(TENANT, PESSOAL, SOURCE, PARTIAL);

    expect(redacted).toEqual(neverRateadoPayload(SOURCE, TOTAL_CENTS));
  });

  it('alvo REMOVIDO derruba o detalhamento mesmo para quem enxerga TUDO: a soma dos vivos não fecha', async () => {
    await seedRateio({ hiddenTargetDeleted: true });

    const full = await service.getRateio(TENANT, PESSOAL, SOURCE, FULL);

    // Antes: `removedTargetsCount: 1` + sobra explicavam a divergência. Sob o
    // contrato aprovado, "soma fecha exatamente" é condição de exibir, e um
    // alvo removido faz Σ(vivos) < total — inclusive para o ADMIN.
    expect(full).toEqual(neverRateadoPayload(SOURCE, TOTAL_CENTS));
    expect(full.removedTargetsCount).toBe(0);
  });

  it('totalmente autorizado: conjunto completo, com as alocações fechando o valorTotal da fonte em centavos exatos', async () => {
    await seedRateio();

    const full = await service.getRateio(TENANT, PESSOAL, SOURCE, FULL);

    expect(full.rateado).toBe(true);
    expect(full.items.map((item) => item.targetExpenseId)).toEqual([
      TARGET_VISIBLE,
      TARGET_HIDDEN,
    ]);
    const soma = full.items.reduce((sum, item) => sum + item.allocationCents, 0);
    expect(soma).toBe(TOTAL_CENTS);
    expect(full.totalSourceCents).toBe(TOTAL_CENTS);
    expect(full.rateadoCents).toBe(TOTAL_CENTS);
    expect(full.sobraCents).toBe(0);
    expect(full.removedTargetsCount).toBe(0);
  });

  it('abrir pelo ALVO resolve a fonte canônica e aplica a ACL na FONTE (nunca por linkedExpenseId)', async () => {
    await seedRateio();
    // `linkedExpenseId` aponta só para o PRIMEIRO alvo: a resolução canônica não
    // pode depender dele.
    await setupPrisma.expense.update({
      where: { id: SOURCE },
      data: { linkedExpenseId: TARGET_VISIBLE },
    });

    const byTarget = await service.getRateio(TENANT, VISIBLE, TARGET_VISIBLE, FULL);
    expect(byTarget.sourceExpenseId).toBe(SOURCE);
    expect(byTarget.items).toHaveLength(2);

    // Quem não alcança a FONTE não enumera o rateio abrindo por um alvo que vê.
    await expect(
      service.getRateio(TENANT, VISIBLE, TARGET_VISIBLE, TARGET_ONLY),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('redigido pela rota do ALVO não revela nem a IDENTIDADE da fonte: colapsa na âncora', async () => {
    await seedRateio();

    const redacted = await service.getRateio(TENANT, VISIBLE, TARGET_VISIBLE, PARTIAL);

    // Devolver `sourceExpenseId: SOURCE` junto de `rateado: false` seria a
    // própria inferência: prova que existe aresta de rateio (senão a resolução
    // canônica nem teria acontecido) e, portanto, que há participante oculto.
    // Source-only pela rota do alvo = o payload da ÂNCORA nunca rateada.
    expect(redacted).toEqual(neverRateadoPayload(TARGET_VISIBLE, VISIBLE_CENTS));
    expect(JSON.stringify(redacted)).not.toContain(SOURCE);
  });

  /**
   * A trava do cliente (`RatearCompraModal`: "não substituir rateio com ocultos")
   * deixa de enxergar ocultos quando a metadata some. Ela só pode degradar
   * porque o SERVIDOR reautoriza cada participante — existente e novo — antes da
   * primeira escrita. Sem esta prova, a remoção da metadata seria uma aposta.
   */
  it('substituição de rateio com participante oculto falha FECHADO no servidor, com zero writes', async () => {
    await seedRateio();
    const before = await allocationSnapshot();

    await expect(
      service.ratear(
        TENANT,
        PESSOAL,
        SOURCE,
        [{ targetExpenseId: TARGET_VISIBLE, allocation: TOTAL_CENTS }],
        PARTIAL,
      ),
    ).rejects.toThrow();

    expect(await allocationSnapshot()).toEqual(before);
  });
});
