import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

type AnyFn = jest.Mock;

/**
 * Mock de Prisma focado em `ratearMixed`: precisamos de project.findMany
 * (validação dos projetos-destino), expense.findFirst (source), expense.create
 * (alvos novos) e $transaction (a orquestração atômica).
 */
const makePrismaMock = () => {
  const expenseMock = {
    findFirst: jest.fn(),
    create: jest.fn(),
  };
  const mock: any = {
    project: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    expense: expenseMock,
    $transaction: jest.fn(),
  };
  // $transaction roda o callback com o próprio mock (representa `tx`).
  mock.$transaction.mockImplementation(async (cb: any) => {
    if (typeof cb === 'function') return cb(mock);
    return Promise.all(cb);
  });
  return mock;
};

describe('ExpenseService.ratearMixed', () => {
  let service: ExpenseService;
  let prisma: ReturnType<typeof makePrismaMock>;
  const tenantId = 'tenant-1';
  const projectId = 'pessoal-1'; // projeto FONTE (PESSOAL)
  const sourceId = 'src-1';

  const source = {
    id: sourceId,
    projectId,
    tenantId,
    deletedAt: null,
    valorTotal: 30000, // R$ 300,00 em centavos
    status: 'PLANEJADO',
    formaPagamento: 'A_VISTA',
  };

  beforeEach(async () => {
    prisma = makePrismaMock();
    prisma.project.findFirst.mockResolvedValue({ id: projectId, tenantId, type: 'PESSOAL' });
    prisma.expense.findFirst.mockResolvedValue({ ...source });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        ConciliacaoService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ExpenseService>(ExpenseService);
  });

  it('cria newTargets nos projetos-destino e rateia numa única transação (allocations concatenadas)', async () => {
    prisma.project.findMany.mockResolvedValue([{ id: 'reforma-1', tenantId, type: 'REFORMA' }]);
    prisma.expense.create.mockResolvedValue({ id: 'novo-1' });
    const ratearSpy = jest
      .spyOn(service['conciliacao'], 'ratearSource')
      .mockResolvedValue({ targets: ['exist-1', 'novo-1'] });

    const res = await service.ratearMixed(tenantId, projectId, sourceId, {
      newTargets: [
        {
          targetProjectId: 'reforma-1',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 100,
          quantidade: 1,
          allocation: 10000,
        } as any,
      ],
      existing: [{ targetExpenseId: 'exist-1', allocation: 20000 }],
    });

    expect(prisma.expense.create).toHaveBeenCalledTimes(1);
    // alvo novo criado no projeto-destino, valorTotal próprio (imutável)
    expect(prisma.expense.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: 'reforma-1', valor: 10000, valorTotal: 10000 }),
      }),
    );
    // ratearSource recebeu allocations concatenadas (existentes + novos)
    expect(ratearSpy).toHaveBeenCalledTimes(1);
    const arg = ratearSpy.mock.calls[0][1];
    expect(arg.sourceExpenseId).toBe(sourceId);
    expect(arg.allocations).toEqual([
      { targetExpenseId: 'exist-1', allocation: 20000 },
      { targetExpenseId: 'novo-1', allocation: 10000 },
    ]);
    expect(res).toEqual(
      expect.objectContaining({ ok: true, sourceId, createdTargetIds: ['novo-1'] }),
    );
  });

  it('rejeita quando soma != source.valorTotal — propaga BadRequest do ratearSource', async () => {
    prisma.project.findMany.mockResolvedValue([{ id: 'reforma-1', tenantId, type: 'REFORMA' }]);
    prisma.expense.create.mockResolvedValue({ id: 'novo-1' });
    jest
      .spyOn(service['conciliacao'], 'ratearSource')
      .mockRejectedValue(new BadRequestException('Sobra != 0'));

    await expect(
      service.ratearMixed(tenantId, projectId, sourceId, {
        newTargets: [
          {
            targetProjectId: 'reforma-1',
            tipoDespesa: 'MATERIAL_CONSTRUCAO',
            valor: 100,
            quantidade: 1,
            allocation: 5000,
          } as any,
        ],
        existing: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rollback: create dos alvos e ratearSource acontecem sob o MESMO callback de $transaction', async () => {
    prisma.project.findMany.mockResolvedValue([{ id: 'reforma-1', tenantId, type: 'REFORMA' }]);
    const txArg: any[] = [];
    prisma.expense.create.mockImplementation(async (arg: any) => {
      txArg.push(['create', arg]);
      return { id: 'novo-1' };
    });
    const ratearSpy = jest
      .spyOn(service['conciliacao'], 'ratearSource')
      .mockImplementation(async (tx: any) => {
        txArg.push(['ratearSource', tx]);
        return { targets: ['novo-1'] };
      });

    await service.ratearMixed(tenantId, projectId, sourceId, {
      newTargets: [
        {
          targetProjectId: 'reforma-1',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 300,
          quantidade: 1,
          allocation: 30000,
        } as any,
      ],
      existing: [],
    });

    // Exatamente 1 $transaction abraça tudo.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // ratearSource recebeu o MESMO tx (o mock do prisma) que os creates.
    expect(ratearSpy.mock.calls[0][0]).toBe(prisma);
    // ordem: create antes de ratearSource (alvos existem antes de ratear).
    expect(txArg.map((t) => t[0])).toEqual(['create', 'ratearSource']);
  });

  it('empty-set: newTargets=[] e existing=[] → BadRequest ("nada a ratear")', async () => {
    await expect(
      service.ratearMixed(tenantId, projectId, sourceId, { newTargets: [], existing: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('newTarget herda source.status quando status ausente (fonte PAGO → alvo PAGO)', async () => {
    prisma.expense.findFirst.mockResolvedValue({ ...source, status: 'PAGO' });
    prisma.project.findMany.mockResolvedValue([{ id: 'reforma-1', tenantId, type: 'REFORMA' }]);
    prisma.expense.create.mockResolvedValue({ id: 'novo-1' });
    jest.spyOn(service['conciliacao'], 'ratearSource').mockResolvedValue({ targets: ['novo-1'] });

    await service.ratearMixed(tenantId, projectId, sourceId, {
      newTargets: [
        {
          targetProjectId: 'reforma-1',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 300,
          quantidade: 1,
          allocation: 30000,
        } as any,
      ],
      existing: [],
    });

    expect(prisma.expense.create.mock.calls[0][0].data.status).toBe('PAGO');
  });

  it('newTarget respeita status explícito quando informado', async () => {
    prisma.expense.findFirst.mockResolvedValue({ ...source, status: 'PAGO' });
    prisma.project.findMany.mockResolvedValue([{ id: 'reforma-1', tenantId, type: 'REFORMA' }]);
    prisma.expense.create.mockResolvedValue({ id: 'novo-1' });
    jest.spyOn(service['conciliacao'], 'ratearSource').mockResolvedValue({ targets: ['novo-1'] });

    await service.ratearMixed(tenantId, projectId, sourceId, {
      newTargets: [
        {
          targetProjectId: 'reforma-1',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 300,
          quantidade: 1,
          status: 'PLANEJADO',
          allocation: 30000,
        } as any,
      ],
      existing: [],
    });

    expect(prisma.expense.create.mock.calls[0][0].data.status).toBe('PLANEJADO');
  });

  it('rejeita targetProjectId de projeto sem módulo expenses → BadRequest', async () => {
    // Projeto de tipo desconhecido/sem feature `expenses`.
    prisma.project.findMany.mockResolvedValue([{ id: 'sem-modulo', tenantId, type: 'DESCONHECIDO' }]);
    const ratearSpy = jest
      .spyOn(service['conciliacao'], 'ratearSource')
      .mockResolvedValue({ targets: [] });

    await expect(
      service.ratearMixed(tenantId, projectId, sourceId, {
        newTargets: [
          {
            targetProjectId: 'sem-modulo',
            tipoDespesa: 'OUTROS',
            valor: 300,
            quantidade: 1,
            allocation: 30000,
          } as any,
        ],
        existing: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // rejeita ANTES de abrir a transação/ratear.
    expect(ratearSpy).not.toHaveBeenCalled();
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  it('source vira espelho (linkedExpenseId) — ratearSource é o responsável e é chamado', async () => {
    prisma.project.findMany.mockResolvedValue([{ id: 'reforma-1', tenantId, type: 'REFORMA' }]);
    prisma.expense.create.mockResolvedValue({ id: 'novo-1' });
    const ratearSpy = jest
      .spyOn(service['conciliacao'], 'ratearSource')
      .mockResolvedValue({ targets: ['novo-1'] });

    await service.ratearMixed(tenantId, projectId, sourceId, {
      newTargets: [
        {
          targetProjectId: 'reforma-1',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 300,
          quantidade: 1,
          allocation: 30000,
        } as any,
      ],
      existing: [],
    });

    // O espelho é setado dentro do ratearSource (não reimplementado aqui).
    expect(ratearSpy).toHaveBeenCalledTimes(1);
  });

  it('NotFound quando a source não existe no projeto/tenant', async () => {
    prisma.expense.findFirst.mockResolvedValue(null);
    await expect(
      service.ratearMixed(tenantId, projectId, sourceId, {
        newTargets: [],
        existing: [{ targetExpenseId: 'exist-1', allocation: 30000 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
