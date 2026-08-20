import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { RateioRequester } from './rateio.types';
import { userCanAccessProject, userCanAccessProjectType } from '../common/access-rules';

const tenantId = 'tenant-1';
const projectId = 'pessoal-1';
const sourceId = 'cmr9mq9l50001cuy6mhhex5nu'; // compra real: Compras TelhaNorte
const TOTAL = 1_277_100;                       // R$ 12.771,00 em centavos

// Datas FIXAS (nada de new Date()) — createdAt idêntico nos dois primeiros para
// provar que o desempate por targetExpenseId é o que garante a ordem.
const T0 = new Date('2026-01-10T12:00:00.000Z');
const T1 = new Date('2026-01-10T12:00:01.000Z');

const REFORMA = { id: 'reforma-1', name: 'Reforma Ap 62', type: 'REFORMA', tenantId };
const OBRA = { id: 'obra-9', name: 'Obra do Vizinho', type: 'REFORMA', tenantId };

/** ADMIN/OWNER: full-access dentro do tenant (guest do demo é ADMIN — auth.service.ts). */
const ADMIN: RateioRequester = { role: 'ADMIN', allowedProjects: [], allowedProjectTypes: [], allowedModules: [] };
/** Restrito POR PROJETO: vê o PESSOAL-fonte, não vê reforma-1 nem obra-9. */
const SO_PESSOAL: RateioRequester = {
  role: 'USER',
  allowedProjects: [projectId],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};
/** Restrito POR TIPO: allowedProjects vazio (opt-in), mas só o tipo PESSOAL. */
const SO_TIPO_PESSOAL: RateioRequester = {
  role: 'USER',
  allowedProjects: [],
  allowedProjectTypes: ['PESSOAL'],
  allowedModules: ['expenses'],
};
/** Vê o PESSOAL e a reforma-1, mas não a obra-9. */
const PESSOAL_E_REFORMA: RateioRequester = {
  role: 'USER',
  allowedProjects: [projectId, REFORMA.id],
  allowedProjectTypes: ['PESSOAL', 'REFORMA'],
  allowedModules: ['expenses'],
};

const alloc = (over: Record<string, unknown> = {}) => ({
  tenantId,
  sourceExpenseId: sourceId,
  targetExpenseId: 'tgt-b',
  allocation: 500_000,
  plannedValorTotal: 620_000,
  createdAt: T0,
  target: {
    id: 'tgt-b',
    titulo: 'Porcelanato sala',
    fornecedor: 'TelhaNorte',
    status: 'PAGO',
    deletedAt: null,
    tenantId,
    projectId: REFORMA.id,
    project: REFORMA,
  },
  ...over,
});

/**
 * B1b (#448): o detalhamento SÓ existe quando a soma fecha exatamente. Testes
 * que não são sobre soma usam este complemento (visível, na REFORMA, sempre
 * ordenado depois de `alloc()`) para satisfazer o invariante — senão passariam
 * pelo motivo errado, redigidos por soma aberta em vez de pela lente.
 */
const filler = (cents: number) =>
  alloc({
    targetExpenseId: 'tgt-fill',
    allocation: cents,
    plannedValorTotal: cents,
    createdAt: T1,
    target: {
      id: 'tgt-fill',
      titulo: 'Complemento que fecha a soma',
      fornecedor: null,
      status: 'PLANEJADO',
      deletedAt: null,
      tenantId,
      projectId: REFORMA.id,
      project: REFORMA,
    },
  });

const makePrismaMock = () => ({
  project: { findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL' }) },
  expense: {
    findFirst: jest.fn().mockResolvedValue({
      id: sourceId, projectId, tenantId, deletedAt: null, valorTotal: TOTAL,
      project: { id: projectId, type: 'PESSOAL', tenantId },
    }),
    update: jest.fn(), updateMany: jest.fn(), create: jest.fn(),
  },
  rateioAllocation: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), update: jest.fn(),
  },
  cashFlowEntry: { updateMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(),
});

describe('ExpenseService.getRateio — leitura canônica do rateio (issue #423)', () => {
  let service: ExpenseService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExpenseService);
  });

  it('enumera TODAS as alocações — não apenas o alvo apontado por linkedExpenseId', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([
      alloc({ targetExpenseId: 'tgt-b', allocation: 500_000, createdAt: T0,
              target: { ...alloc().target, id: 'tgt-b' } }),
      alloc({ targetExpenseId: 'tgt-a', allocation: 477_100, plannedValorTotal: null, createdAt: T0,
              target: { id: 'tgt-a', titulo: null, fornecedor: 'TelhaNorte', status: 'PLANEJADO',
                        deletedAt: null, tenantId, projectId: REFORMA.id, project: REFORMA } }),
      alloc({ targetExpenseId: 'tgt-c', allocation: 300_000, createdAt: T1,
              target: { id: 'tgt-c', titulo: 'Rejunte', fornecedor: null, status: 'PAGO',
                        deletedAt: null, tenantId, projectId: REFORMA.id, project: REFORMA } }),
    ]);

    const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);

    expect(res.rateado).toBe(true);
    expect(res.items).toHaveLength(3);                     // mutação: retornar só o 1º alvo
    expect(res.items.map((i) => i.targetExpenseId)).toEqual(['tgt-a', 'tgt-b', 'tgt-c']);
    expect(res.totalSourceCents).toBe(TOTAL);
    expect(res.rateadoCents).toBe(1_277_100);              // 500000+477100+300000 exato
    expect(res.sobraCents).toBe(0);
    expect(res.removedTargetsCount).toBe(0);
    expect(res.sourceExpenseId).toBe(sourceId);
  });

  it('preserva o contrato tipado de cada item (título cru, projeto, snapshot, status)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc(), filler(TOTAL - 500_000)]);
    const [item] = (await service.getRateio(tenantId, projectId, sourceId, ADMIN)).items;
    expect(item).toEqual({
      targetExpenseId: 'tgt-b',
      titulo: 'Porcelanato sala',
      fornecedor: 'TelhaNorte',
      projectId: 'reforma-1',
      projectName: 'Reforma Ap 62',
      projectType: 'REFORMA',
      allocationCents: 500_000,
      plannedValorTotalCents: 620_000,
      status: 'PAGO',
    });
  });

  it('plannedValorTotal ausente (rateio legado) permanece null — nunca vira 0', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([
      alloc({ plannedValorTotal: null }),
      filler(TOTAL - 500_000),
    ]);
    const [item] = (await service.getRateio(tenantId, projectId, sourceId, ADMIN)).items;
    expect(item.plannedValorTotalCents).toBeNull();        // mutação: `?? 0`
  });

  it('ordena de forma determinística com desempate TOTAL por targetExpenseId', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([]);
    await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(prisma.rateioAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { targetExpenseId: 'asc' }], // mutação: remover o desempate
      }),
    );
  });

  it('escopa por tenantId E sourceExpenseId na própria alocação (I5)', async () => {
    await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(prisma.rateioAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, sourceExpenseId: sourceId } }),
    );
  });

  it('alvo soft-deletado chega pelo include ($use NÃO filtra) e derruba o detalhamento (B1b #448)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([
      alloc({ targetExpenseId: 'tgt-a', allocation: 1_000_000, createdAt: T0,
              target: { id: 'tgt-a', titulo: 'Vivo', fornecedor: null, status: 'PAGO',
                        deletedAt: null, tenantId, projectId: REFORMA.id, project: REFORMA } }),
      alloc({ targetExpenseId: 'tgt-z', allocation: 277_100, createdAt: T1,
              target: { id: 'tgt-z', titulo: 'Apagado', fornecedor: null, status: 'PAGO',
                        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
                        tenantId, projectId: REFORMA.id, project: REFORMA } }),
    ]);

    const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);

    // I4 continua valendo: o `$use` não filtra dentro do `include`, então o
    // service PRECISA reconhecer o `deletedAt` sozinho. O que mudou em B1b é a
    // consequência — com um alvo removido a soma dos vivos não fecha, e o
    // contrato manda devolver source-only em vez de expor a divergência.
    expect(res).toEqual({
      sourceExpenseId: sourceId,
      rateado: false,
      totalSourceCents: TOTAL,
      rateadoCents: 0,
      sobraCents: TOTAL,
      removedTargetsCount: 0,
      items: [],
    });
    expect(JSON.stringify(res)).not.toContain('Apagado');   // mutação: item removido virar item
    expect(JSON.stringify(res)).not.toContain('tgt-a');
  });

  it('N=0 alocações: rateado=false, lista vazia, sobra = total (fronteira)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([]);
    const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(res).toEqual({
      sourceExpenseId: sourceId, rateado: false, totalSourceCents: TOTAL,
      rateadoCents: 0, sobraCents: TOTAL, removedTargetsCount: 0, items: [],
    });
  });

  it('NONE procura vínculo de alvo com tenantId e mantém o payload falso ancorado na despesa', async () => {
    const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);

    expect(prisma.rateioAllocation.findFirst).toHaveBeenCalledWith({
      where: { tenantId, targetExpenseId: sourceId },
      select: { sourceExpenseId: true },
    });
    expect(res.sourceExpenseId).toBe(sourceId);
    expect(res.rateado).toBe(false);
    expect(res.totalSourceCents).toBe(TOTAL);
  });

  it('N=1 alocação já é rateio (fronteira 0→1)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc({ allocation: TOTAL })]);
    const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(res.rateado).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.sobraCents).toBe(0);
  });

  it('SOURCE vence TARGET e não procura vínculo reverso quando a âncora já tem alocações', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc({ allocation: TOTAL })]);

    await service.getRateio(tenantId, projectId, sourceId, ADMIN);

    expect(prisma.rateioAllocation.findFirst).not.toHaveBeenCalled();
  });

  describe('âncora TARGET (issue #428)', () => {
    const targetAnchor = {
      id: 'tgt-b',
      projectId: REFORMA.id,
      tenantId,
      deletedAt: null,
      valorTotal: 620_000,
      project: REFORMA,
    };
    const sourceExpense = {
      id: sourceId,
      projectId,
      tenantId,
      deletedAt: null,
      valorTotal: TOTAL,
      project: { id: projectId, type: 'PESSOAL', tenantId },
    };

    function useTargetPath(
      sourceResult: {
        id: string;
        projectId: string;
        tenantId: string;
        deletedAt: Date | null;
        valorTotal: number;
        project: { id: string; type: string; tenantId: string };
      } | null = sourceExpense,
      allocations = [alloc(), filler(TOTAL - 500_000)],
    ) {
      prisma.expense.findFirst.mockImplementation(({ where }) =>
        Promise.resolve(where.id === targetAnchor.id ? targetAnchor : sourceResult),
      );
      prisma.rateioAllocation.findFirst.mockResolvedValue({ sourceExpenseId: sourceId });
      prisma.rateioAllocation.findMany.mockImplementation(({ where }) =>
        Promise.resolve(where.sourceExpenseId === sourceId ? allocations : []),
      );
    }

    it('retorna o mesmo detalhe canônico ao abrir por um alvo ou pela fonte', async () => {
      useTargetPath();

      const viaTarget = await service.getRateio(tenantId, REFORMA.id, targetAnchor.id, ADMIN);
      const viaSource = await service.getRateio(tenantId, projectId, sourceId, ADMIN);

      expect(viaTarget).toEqual(viaSource);
      expect(viaTarget.sourceExpenseId).toBe(sourceId);
      expect(prisma.expense.findFirst).toHaveBeenCalledWith({
        where: {
          id: sourceId,
          tenantId,
          deletedAt: null,
          project: { tenantId, deletedAt: null },
        },
        include: { project: { select: { id: true, type: true, tenantId: true } } },
      });
    });

    it('fonte fora da lente do requester devolve 404 genérico, nunca 403', async () => {
      useTargetPath({
        ...sourceExpense,
        projectId: OBRA.id,
        project: OBRA,
      });

      await expect(
        service.getRateio(tenantId, REFORMA.id, targetAnchor.id, PESSOAL_E_REFORMA),
      ).rejects.toMatchObject({
        status: 404,
        message: 'Despesa não encontrada',
      });
    });

    it.each([
      ['inexistente', null],
      ['removida', { ...sourceExpense, deletedAt: new Date('2026-02-02T00:00:00.000Z') }],
      [
        'cross-tenant',
        {
          ...sourceExpense,
          tenantId: 'tenant-2',
          project: { ...sourceExpense.project, tenantId: 'tenant-2' },
        },
      ],
    ])('fonte %s devolve 404 genérico', async (_case, invalidSource) => {
      useTargetPath(invalidSource);

      await expect(
        service.getRateio(tenantId, REFORMA.id, targetAnchor.id, ADMIN),
      ).rejects.toMatchObject({
        status: 404,
        message: 'Despesa não encontrada',
      });
    });

    it('rateio não integralmente visível pela rota do alvo: source-only ancorado na ÂNCORA, sem a identidade da fonte', async () => {
      useTargetPath(sourceExpense, [
        alloc(),
        alloc({
          targetExpenseId: 'tgt-hidden',
          allocation: 400_000,
          createdAt: T1,
          target: {
            id: 'tgt-hidden',
            titulo: 'Oculto',
            fornecedor: null,
            status: 'PAGO',
            deletedAt: null,
            tenantId,
            projectId: OBRA.id,
            project: OBRA,
          },
        }),
        alloc({
          targetExpenseId: 'tgt-removed',
          allocation: 100_000,
          createdAt: T1,
          target: {
            id: 'tgt-removed',
            titulo: 'Removido',
            fornecedor: null,
            status: 'PAGO',
            deletedAt: new Date('2026-02-01T00:00:00.000Z'),
            tenantId,
            projectId: REFORMA.id,
            project: REFORMA,
          },
        }),
      ]);

      const res = await service.getRateio(
        tenantId,
        REFORMA.id,
        targetAnchor.id,
        PESSOAL_E_REFORMA,
      );

      // B1b (#448): pela rota do ALVO a redação colapsa na ÂNCORA. Devolver
      // `sourceExpenseId: sourceId` com `rateado: false` provaria que existe
      // aresta de rateio (a resolução canônica só roda quando a âncora é alvo
      // de alguém) e, portanto, que há participante que o requisitante não vê.
      expect(res).toEqual({
        sourceExpenseId: targetAnchor.id,
        rateado: false,
        totalSourceCents: targetAnchor.valorTotal,
        rateadoCents: 0,
        sobraCents: targetAnchor.valorTotal,
        removedTargetsCount: 0,
        items: [],
      });
      expect(JSON.stringify(res)).not.toContain(sourceId);
      expect(res).not.toHaveProperty('hiddenTargetsCount');
      expect(res).not.toHaveProperty('hiddenAllocationCents');
    });
  });

  it('404 quando a fonte não pertence ao projeto/tenant, sem consultar alocações', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    await expect(service.getRateio(tenantId, projectId, sourceId, ADMIN)).rejects.toThrow(NotFoundException);
    expect(prisma.rateioAllocation.findMany).not.toHaveBeenCalled();
    expect(prisma.expense.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: sourceId, projectId, tenantId, deletedAt: null } }),
    );
  });

  it('é estritamente somente-leitura (I7): nenhuma escrita, nenhuma transação', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc()]);
    await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(prisma.expense.update).not.toHaveBeenCalled();
    expect(prisma.expense.updateMany).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.upsert).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.delete).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.cashFlowEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('faz UMA única query de alocações (snapshot atômico — sem leitura rasgada §3A)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc()]);
    await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(prisma.rateioAllocation.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.expense.findFirst).toHaveBeenCalledTimes(1); // só a fonte; alvos vêm no include
  });

  it('cenário Telhanorte: 9 alocações fecham 1.277.100 exatos, sobra 0, nada oculto (ADMIN)', async () => {
    const cents = [142_400, 141_400, 142_400, 141_400, 142_400, 141_400, 141_900, 141_900, 141_900];
    expect(cents.reduce((s, v) => s + v, 0)).toBe(TOTAL); // fixture se auto-verifica
    prisma.rateioAllocation.findMany.mockResolvedValue(
      cents.map((allocation, i) =>
        alloc({
          targetExpenseId: `tgt-${i}`, allocation, plannedValorTotal: allocation, createdAt: T0,
          target: { id: `tgt-${i}`, titulo: `Item ${i + 1} da reforma`, fornecedor: null,
                    status: 'PLANEJADO', deletedAt: null, tenantId,
                    projectId: REFORMA.id, project: REFORMA },
        }),
      ),
    );
    const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(res.items).toHaveLength(9);
    expect(res.rateadoCents).toBe(TOTAL);
    expect(res.sobraCents).toBe(0);
    expect(res.removedTargetsCount).toBe(0);
  });

  describe('lente de acesso do requisitante (issue #423 — gap HIGH do security-tenant-lens)', () => {
    /** A: alvo ativo na REFORMA · B: alvo ativo na OBRA (fora da lente) · C: alvo REMOVIDO na REFORMA. */
    const cenarioMisto = () => [
      alloc({ targetExpenseId: 'tgt-a', allocation: 500_000, createdAt: T0,
        target: { id: 'tgt-a', titulo: 'Porcelanato sala', fornecedor: 'TelhaNorte', status: 'PAGO',
                  deletedAt: null, tenantId, projectId: REFORMA.id, project: REFORMA } }),
      alloc({ targetExpenseId: 'tgt-b', allocation: 400_000, createdAt: T1,
        target: { id: 'tgt-b', titulo: 'Cimento do vizinho', fornecedor: 'Loja Secreta', status: 'PAGO',
                  deletedAt: null, tenantId, projectId: OBRA.id, project: OBRA } }),
      alloc({ targetExpenseId: 'tgt-c', allocation: 100_000, createdAt: T1,
        target: { id: 'tgt-c', titulo: 'Apagado', fornecedor: null, status: 'PAGO',
                  deletedAt: new Date('2026-02-01T00:00:00.000Z'),
                  tenantId, projectId: REFORMA.id, project: REFORMA } }),
    ];

    it('NÃO vaza título/fornecedor/nome de projeto de alvo fora da lente do usuário', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue(cenarioMisto());
      const res = await service.getRateio(tenantId, projectId, sourceId, PESSOAL_E_REFORMA);

      // B1b (#448): com um participante fora da lente, NADA do rateio é
      // enumerado — nem o alvo autorizado. Devolver `tgt-a` sozinho já contaria
      // que existe rateio, e a partir daí a sobra conta o resto por subtração.
      expect(res.items).toEqual([]);
      const serializado = JSON.stringify(res);
      for (const segredo of ['tgt-a', 'tgt-b', 'obra-9', 'Obra do Vizinho', 'Cimento do vizinho', 'Loja Secreta']) {
        expect(serializado).not.toContain(segredo); // inclui o ID: nada de sonda cross-project
      }
    });

    it('rateio parcialmente visível é source-only INTEIRO: nem lista, nem contador, nem soma (B1b #448)', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue(cenarioMisto());
      const res = await service.getRateio(tenantId, projectId, sourceId, PESSOAL_E_REFORMA);

      // Contrato SOURCE-ONLY, tudo-ou-nada. Uma LISTA FILTRADA não fecha o
      // vazamento: como a escrita exige Σ alocações === valorTotal
      // (conciliacao.service.ts:705), `totalSourceCents - Σ(itens)` seria a soma
      // oculta em centavos exatos.
      expect(res).toEqual({
        sourceExpenseId: sourceId,
        rateado: false,
        totalSourceCents: TOTAL,
        rateadoCents: 0,
        sobraCents: TOTAL,
        removedTargetsCount: 0,
        items: [],
      });
      expect(res).not.toHaveProperty('hiddenTargetsCount');
      expect(res).not.toHaveProperty('hiddenAllocationCents');
      // A subtração não devolve mais a fatia oculta (400_000).
      expect(res.totalSourceCents - res.rateadoCents).not.toBe(400_000);
    });

    it('I-D revista (B1b #448): a lente decide TER ou NÃO TER detalhamento, não "quanto" dele', async () => {
      // Fixture que FECHA a soma: assim a única causa de redação é a lente.
      const doisAlvosQueFecham = () => [
        alloc({ targetExpenseId: 'tgt-a', allocation: 500_000, createdAt: T0,
          target: { id: 'tgt-a', titulo: 'Porcelanato sala', fornecedor: 'TelhaNorte', status: 'PAGO',
                    deletedAt: null, tenantId, projectId: REFORMA.id, project: REFORMA } }),
        alloc({ targetExpenseId: 'tgt-b', allocation: TOTAL - 500_000, createdAt: T1,
          target: { id: 'tgt-b', titulo: 'Cimento do vizinho', fornecedor: 'Loja Secreta', status: 'PAGO',
                    deletedAt: null, tenantId, projectId: OBRA.id, project: OBRA } }),
      ];

      prisma.rateioAllocation.findMany.mockResolvedValue(doisAlvosQueFecham());
      const comoAdmin = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
      prisma.rateioAllocation.findMany.mockResolvedValue(doisAlvosQueFecham());
      const comoRestrito = await service.getRateio(tenantId, projectId, sourceId, PESSOAL_E_REFORMA);

      // Quem enxerga TODOS os participantes e vê a soma fechar: detalhe completo.
      expect(comoAdmin.items).toHaveLength(2);
      expect(comoAdmin.rateadoCents).toBe(TOTAL);
      expect(comoAdmin.sobraCents).toBe(0);
      // Quem não enxerga um deles: a resposta de uma compra nunca rateada.
      // Não uma versão "menor" do detalhe — nenhuma versão dele.
      expect(comoRestrito.items).toEqual([]);
      expect(comoRestrito.rateado).toBe(false);
      expect(comoRestrito.rateadoCents).toBe(0);
      // O total da FONTE é despesa do próprio requisitante: continua visível.
      expect(comoRestrito.totalSourceCents).toBe(comoAdmin.totalSourceCents);
      expect(comoAdmin).not.toHaveProperty('hiddenTargetsCount');
      expect(comoAdmin).not.toHaveProperty('hiddenAllocationCents');
    });

    it('restrição por TIPO de projeto oculta igual à restrição por projeto (as duas regras do guard)', async () => {
      // Alocação ÚNICA que fecha a soma: a redação só pode vir da lente por tipo.
      prisma.rateioAllocation.findMany.mockResolvedValue([
        alloc({ allocation: TOTAL, plannedValorTotal: TOTAL }),
      ]);
      const res = await service.getRateio(tenantId, projectId, sourceId, SO_TIPO_PESSOAL);
      expect(res.items).toHaveLength(0);          // mutação: checar só userCanAccessProject
      expect(res).not.toHaveProperty('hiddenTargetsCount');
      expect(res).not.toHaveProperty('hiddenAllocationCents');
      // B1b: com 100% dos participantes fora da lente, nem o FLAG sobrevive —
      // `rateado: true` aqui anunciaria "alguém dividiu isso com você".
      expect(res.rateado).toBe(false);
      expect(res.rateadoCents).toBe(0);
      expect(res.sobraCents).toBe(TOTAL);
    });

    it('fronteira: TODOS os alvos ocultos → resposta idêntica à de uma compra nunca rateada', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue([
        alloc({ targetExpenseId: 'tgt-a', allocation: TOTAL, createdAt: T0,
          target: { id: 'tgt-a', titulo: 'X', fornecedor: null, status: 'PAGO', deletedAt: null,
                    tenantId, projectId: OBRA.id, project: OBRA } }),
      ]);
      const res = await service.getRateio(tenantId, projectId, sourceId, SO_PESSOAL);

      prisma.rateioAllocation.findMany.mockResolvedValue([]);   // nunca rateada
      const nunca = await service.getRateio(tenantId, projectId, sourceId, SO_PESSOAL);

      expect(JSON.stringify(res)).toBe(JSON.stringify(nunca)); // deep-equal serializado
      expect(res.items).toEqual([]);
      expect(res.rateado).toBe(false);
      expect(res.rateadoCents).toBe(0);
      expect(res.sobraCents).toBe(TOTAL);   // mutação: sobra 0 delata a alocação oculta
    });

    it('I-F revisto (B1b #448): alvo removido derruba o detalhamento — DENTRO ou FORA da lente', async () => {
      const removido = (project: typeof REFORMA) =>
        alloc({ targetExpenseId: 'tgt-z', allocation: TOTAL, createdAt: T0,
          target: { id: 'tgt-z', titulo: 'Sumido', fornecedor: null, status: 'PAGO',
                    deletedAt: new Date('2026-02-01T00:00:00.000Z'),
                    tenantId, projectId: project.id, project } });

      // Antes: `removedTargetsCount: 1` + sobra explicavam a divergência a quem
      // enxergava o projeto. Agora "a soma dos vivos fecha" é CONDIÇÃO de
      // exibir, então um alvo removido colapsa a resposta para os dois casos —
      // e assim "removido" deixa de ser um estado distinguível de "não rateado".
      prisma.rateioAllocation.findMany.mockResolvedValue([removido(REFORMA)]);
      const dentro = await service.getRateio(tenantId, projectId, sourceId, PESSOAL_E_REFORMA);

      prisma.rateioAllocation.findMany.mockResolvedValue([removido(OBRA)]);
      const fora = await service.getRateio(tenantId, projectId, sourceId, SO_PESSOAL);

      expect(JSON.stringify(dentro)).toBe(JSON.stringify(fora));
      for (const res of [dentro, fora]) {
        expect(res.removedTargetsCount).toBe(0);
        expect(res).not.toHaveProperty('hiddenTargetsCount');
        expect(res.rateado).toBe(false);
        expect(res.rateadoCents).toBe(0);
        expect(res.sobraCents).toBe(TOTAL);
      }
    });

    it('I-G: alvo de OUTRO tenant no join nunca entra nos itens, nem para ADMIN', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue([
        alloc({ targetExpenseId: 'tgt-alien', allocation: TOTAL, createdAt: T0,
          target: { id: 'tgt-alien', titulo: 'Dado de outro tenant', fornecedor: null, status: 'PAGO',
                    deletedAt: null, tenantId: 'tenant-2', projectId: 'p-alien',
                    project: { id: 'p-alien', name: 'Projeto Alheio', type: 'REFORMA', tenantId: 'tenant-2' } } }),
      ]);
      const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
      expect(res.items).toEqual([]);                       // ADMIN é full-access DO PRÓPRIO tenant
      expect(res).not.toHaveProperty('hiddenTargetsCount');
      expect(res).not.toHaveProperty('hiddenAllocationCents');
      expect(res.rateadoCents).toBe(0);                    // nem a SOMA do alienígena vaza
      expect(JSON.stringify(res)).not.toContain('Projeto Alheio');
    });

    it('fail-closed: sem requester (chamada interna/JS) → 403, jamais payload completo', async () => {
      await expect(
        (service as any).getRateio(tenantId, projectId, sourceId, undefined),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.rateioAllocation.findMany).not.toHaveBeenCalled();
    });

    it('defesa em profundidade na FONTE: projeto-fonte fora da lente → 403 (guard não é a única trava)', async () => {
      const semAcesso: RateioRequester = {
        role: 'USER', allowedProjects: ['outro-projeto'],
        allowedProjectTypes: ['PESSOAL'], allowedModules: ['expenses'],
      };
      await expect(service.getRateio(tenantId, projectId, sourceId, semAcesso))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.rateioAllocation.findMany).not.toHaveBeenCalled();
    });

    it('I-G na fonte: projeto-fonte de outro tenant → 404 (não confirma existência)', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: sourceId, projectId, tenantId, deletedAt: null, valorTotal: TOTAL,
        project: { id: projectId, type: 'PESSOAL', tenantId: 'tenant-2' },
      });
      await expect(service.getRateio(tenantId, projectId, sourceId, ADMIN))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('continua read-only e com UMA query de alocações mesmo com filtro de acesso', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue(cenarioMisto());
      await service.getRateio(tenantId, projectId, sourceId, PESSOAL_E_REFORMA);
      expect(prisma.rateioAllocation.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.expense.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.project.findFirst).not.toHaveBeenCalled();   // nada de resolveAccessibleProjectScope
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });

    it('paridade com o ProjectAccessGuard: mesma decisão para as mesmas entradas', async () => {
      const casos: Array<[RateioRequester, boolean]> = [
        [ADMIN, true], [PESSOAL_E_REFORMA, true], [SO_PESSOAL, false], [SO_TIPO_PESSOAL, false],
      ];
      for (const [requester, deveriaVer] of casos) {
        const guardPermite =
          userCanAccessProject(requester.role, requester.allowedProjects, REFORMA.id) &&
          userCanAccessProjectType(requester.role, requester.allowedProjectTypes,
                                   requester.allowedModules ?? [], REFORMA.type);
        expect(guardPermite).toBe(deveriaVer);          // trava a fixture
        // Alocação única que FECHA a soma: o que decide item-ou-nada aqui é
        // exclusivamente a lente, não o invariante de soma.
        prisma.rateioAllocation.findMany.mockResolvedValue([
          alloc({ allocation: TOTAL, plannedValorTotal: TOTAL }),
        ]);
        const res = await service.getRateio(tenantId, projectId, sourceId, requester);
        expect(res.items.length > 0).toBe(deveriaVer);  // service NUNCA mais frouxo que o guard
      }
    });
  });
});
