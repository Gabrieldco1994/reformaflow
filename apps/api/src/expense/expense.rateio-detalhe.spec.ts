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
    expect(res.hiddenTargetsCount).toBe(0);
    expect(res.hiddenAllocationCents).toBe(0);
    expect(res.sourceExpenseId).toBe(sourceId);
  });

  it('preserva o contrato tipado de cada item (título cru, projeto, snapshot, status)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc()]);
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
    prisma.rateioAllocation.findMany.mockResolvedValue([alloc({ plannedValorTotal: null })]);
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

  it('exclui alvo soft-deletado dos itens, conta em removedTargetsCount e expõe a sobra', async () => {
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

    expect(res.items.map((i) => i.targetExpenseId)).toEqual(['tgt-a']); // I4: $use NÃO filtra o include
    expect(res.removedTargetsCount).toBe(1);
    expect(res.rateadoCents).toBe(1_000_000);
    expect(res.sobraCents).toBe(277_100);                  // divergência EXPOSTA, não absorvida
    expect(res.rateado).toBe(true);                        // ainda há alocação
  });

  it('N=0 alocações: rateado=false, lista vazia, sobra = total (fronteira)', async () => {
    prisma.rateioAllocation.findMany.mockResolvedValue([]);
    const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
    expect(res).toEqual({
      sourceExpenseId: sourceId, rateado: false, totalSourceCents: TOTAL,
      rateadoCents: 0, sobraCents: TOTAL, removedTargetsCount: 0,
      hiddenTargetsCount: 0, hiddenAllocationCents: 0, items: [],
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
      allocations = [alloc()],
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

    it('mantém ocultos e removidos ao enumerar o rateio completo pela rota do alvo', async () => {
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

      expect(res.items.map((item) => item.targetExpenseId)).toEqual(['tgt-b']);
      expect(res.sourceExpenseId).toBe(sourceId);
      expect(res.rateadoCents).toBe(900_000);
      expect(res.sobraCents).toBe(377_100);
      expect(res.hiddenTargetsCount).toBe(1);
      expect(res.hiddenAllocationCents).toBe(400_000);
      expect(res.removedTargetsCount).toBe(1);
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
    expect(res.hiddenTargetsCount).toBe(0);
    expect(res.hiddenAllocationCents).toBe(0);
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

      expect(res.items.map((i) => i.targetExpenseId)).toEqual(['tgt-a']); // mutação: devolver tgt-b
      const serializado = JSON.stringify(res);
      for (const segredo of ['tgt-b', 'obra-9', 'Obra do Vizinho', 'Cimento do vizinho', 'Loja Secreta']) {
        expect(serializado).not.toContain(segredo); // inclui o ID: nada de sonda cross-project
      }
    });

    it('a alocação oculta vira contador explícito — nunca `sobra` fantasma (I-A)', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue(cenarioMisto());
      const res = await service.getRateio(tenantId, projectId, sourceId, PESSOAL_E_REFORMA);

      expect(res.hiddenTargetsCount).toBe(1);
      expect(res.hiddenAllocationCents).toBe(400_000);
      expect(res.removedTargetsCount).toBe(1);                 // I-F: removido não vira oculto
      expect(res.rateadoCents).toBe(900_000);                  // 500k visível + 400k oculto
      expect(res.sobraCents).toBe(TOTAL - 900_000);

      const soma = res.items.reduce((s, i) => s + i.allocationCents, 0) + res.hiddenAllocationCents;
      expect(soma).toBe(res.rateadoCents);                     // I-A explícita
      expect(res.items.length + res.hiddenTargetsCount + res.removedTargetsCount).toBe(3); // I-C
    });

    it('I-D: os números do dinheiro são IDÊNTICOS para ADMIN e para restrito', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue(cenarioMisto());
      const comoAdmin = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
      prisma.rateioAllocation.findMany.mockResolvedValue(cenarioMisto());
      const comoRestrito = await service.getRateio(tenantId, projectId, sourceId, PESSOAL_E_REFORMA);

      const dinheiro = (r: any) => ({
        rateado: r.rateado, totalSourceCents: r.totalSourceCents,
        rateadoCents: r.rateadoCents, sobraCents: r.sobraCents,
        removedTargetsCount: r.removedTargetsCount,
      });
      expect(dinheiro(comoRestrito)).toEqual(dinheiro(comoAdmin)); // ACL não move dinheiro
      expect(comoAdmin.items).toHaveLength(2);
      expect(comoAdmin.hiddenTargetsCount).toBe(0);
      expect(comoAdmin.hiddenAllocationCents).toBe(0);
    });

    it('restrição por TIPO de projeto oculta igual à restrição por projeto (as duas regras do guard)', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue([cenarioMisto()[0]]); // alvo REFORMA
      const res = await service.getRateio(tenantId, projectId, sourceId, SO_TIPO_PESSOAL);
      expect(res.items).toHaveLength(0);          // mutação: checar só userCanAccessProject
      expect(res.hiddenTargetsCount).toBe(1);
      expect(res.hiddenAllocationCents).toBe(500_000);
      expect(res.rateado).toBe(true);             // ele SABE que a compra dele é rateada
    });

    it('fronteira: TODOS os alvos ocultos → lista vazia, rateado=true, sobra 0', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue([
        alloc({ targetExpenseId: 'tgt-a', allocation: TOTAL, createdAt: T0,
          target: { id: 'tgt-a', titulo: 'X', fornecedor: null, status: 'PAGO', deletedAt: null,
                    tenantId, projectId: OBRA.id, project: OBRA } }),
      ]);
      const res = await service.getRateio(tenantId, projectId, sourceId, SO_PESSOAL);
      expect(res.items).toEqual([]);
      expect(res.rateado).toBe(true);
      expect(res.hiddenTargetsCount).toBe(1);
      expect(res.hiddenAllocationCents).toBe(TOTAL);
      expect(res.sobraCents).toBe(0);   // mutação: rateadoCents = Σ items ⇒ sobra = TOTAL (falso alarme)
    });

    it('I-F: alvo REMOVIDO e inacessível conta como removido, não como oculto', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue([
        alloc({ targetExpenseId: 'tgt-z', allocation: 300_000, createdAt: T0,
          target: { id: 'tgt-z', titulo: 'Sumido', fornecedor: null, status: 'PAGO',
                    deletedAt: new Date('2026-02-01T00:00:00.000Z'),
                    tenantId, projectId: OBRA.id, project: OBRA } }),
      ]);
      const res = await service.getRateio(tenantId, projectId, sourceId, SO_PESSOAL);
      expect(res.removedTargetsCount).toBe(1);
      expect(res.hiddenTargetsCount).toBe(0);
      expect(res.hiddenAllocationCents).toBe(0);
      expect(res.rateadoCents).toBe(0);
      expect(res.sobraCents).toBe(TOTAL);   // a sobra do removido continua EXPOSTA
    });

    it('I-G: alvo de OUTRO tenant no join nunca entra nos itens, nem para ADMIN', async () => {
      prisma.rateioAllocation.findMany.mockResolvedValue([
        alloc({ targetExpenseId: 'tgt-alien', allocation: 250_000, createdAt: T0,
          target: { id: 'tgt-alien', titulo: 'Dado de outro tenant', fornecedor: null, status: 'PAGO',
                    deletedAt: null, tenantId: 'tenant-2', projectId: 'p-alien',
                    project: { id: 'p-alien', name: 'Projeto Alheio', type: 'REFORMA', tenantId: 'tenant-2' } } }),
      ]);
      const res = await service.getRateio(tenantId, projectId, sourceId, ADMIN);
      expect(res.items).toEqual([]);                       // ADMIN é full-access DO PRÓPRIO tenant
      expect(res.hiddenTargetsCount).toBe(1);
      expect(res.hiddenAllocationCents).toBe(250_000);
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
        prisma.rateioAllocation.findMany.mockResolvedValue([cenarioMisto()[0]]);
        const res = await service.getRateio(tenantId, projectId, sourceId, requester);
        expect(res.items.length > 0).toBe(deveriaVer);  // service NUNCA mais frouxo que o guard
      }
    });
  });
});
