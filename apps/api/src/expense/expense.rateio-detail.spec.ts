import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

/**
 * QA (issue #423) — cobertura RED do endpoint de LEITURA read-only do rateio:
 * `GET /projects/:projectId/expenses/:id/rateio`.
 *
 * Nesta branch (`test/rateio-details`) a produção ainda NÃO existe — o
 * `backend-expert` implementa `ExpenseService.getRateioDetail` a partir do
 * contrato fixado aqui + issue #423. Os testes abaixo DEVEM falhar agora
 * (RED, `service.getRateioDetail is not a function`) e devem ficar verdes
 * quando o método existir com o contrato assumido:
 *
 *   getRateioDetail(tenantId, projectId, sourceId): Promise<{
 *     sourceId: string;
 *     totalCents: number;      // Expense.valorTotal da fonte
 *     allocatedCents: number;  // soma das RateioAllocation.allocation
 *     sobraCents: number;      // totalCents - allocatedCents
 *     items: Array<{
 *       targetExpenseId: string;
 *       titulo: string | null;
 *       fornecedor: string | null;
 *       project: { id: string; name: string; type: string } | null;
 *       allocation: number;             // centavos
 *       plannedValorTotal: number | null; // snapshot original do alvo (imutável)
 *       targetRemoved: boolean;         // true se o alvo foi soft-deleted
 *     }>;
 *   }>
 *
 * Lança NotFoundException quando: projeto não pertence ao tenant, fonte não
 * encontrada (id/projectId/tenantId não batem) OU fonte sem NENHUMA
 * RateioAllocation (contrato escolhido entre o "404 OU []" que a issue
 * permite — ver retorno do QA para o backend-expert confirmar/ajustar).
 *
 * `(service as any)` é usado deliberadamente: a interface real de
 * `ExpenseService` ainda não declara `getRateioDetail`, e o teste não deve
 * quebrar `tsc --noEmit` (pre-commit) só por referenciar um método futuro —
 * a falha esperada é EM TEMPO DE EXECUÇÃO (RED comportamental), não de
 * compilação.
 */

interface RateioAllocationRow {
  id: string;
  tenantId: string;
  sourceExpenseId: string;
  targetExpenseId: string;
  allocation: number;
  plannedValorTotal: number | null;
  target: {
    id: string;
    titulo: string | null;
    fornecedor: string | null;
    deletedAt: Date | null;
    project: { id: string; name: string; type: string } | null;
  } | null;
}

function makeSource(over: Partial<any> = {}) {
  return {
    id: 'src-telhanorte',
    tenantId: 't1',
    projectId: 'pessoal1',
    titulo: 'Compras TelhaNorte',
    valorTotal: 1_277_100, // R$ 12.771,00
    formaPagamento: 'PARCELADO',
    quantidadeParcela: 10,
    deletedAt: null,
    linkedExpenseId: null,
    ...over,
  };
}

function makeAllocationRow(over: Partial<RateioAllocationRow> = {}): RateioAllocationRow {
  return {
    id: `ra-${over.targetExpenseId ?? 'x'}`,
    tenantId: 't1',
    sourceExpenseId: 'src-telhanorte',
    targetExpenseId: 'tgt-x',
    allocation: 100_000,
    plannedValorTotal: 100_000,
    target: {
      id: 'tgt-x',
      titulo: 'Item da reforma',
      fornecedor: null,
      deletedAt: null,
      project: { id: 'reforma1', name: 'Reforma Cozinha', type: 'REFORMA' },
    },
    ...over,
  };
}

/**
 * 9 alvos da REFORMA rateados a partir da compra Telhanorte de R$ 12.771,00
 * (1.277.100 centavos) — mesmo cenário citado na issue #423. A soma das 9
 * fatias FECHA o total exatamente (nenhum resto de arredondamento): é o que
 * o `ratearSource` (motor já existente, #18) garante na escrita, e a leitura
 * não pode reintroduzir erro de soma.
 */
function nineTelhanorteAllocations(): RateioAllocationRow[] {
  const cents = [
    142_400, 141_400, 142_400, 141_400, 142_400, 141_400, 141_900, 141_900, 141_900,
  ];
  const total = cents.reduce((s, v) => s + v, 0);
  if (total !== 1_277_100) {
    throw new Error(`fixture quebrada: soma das 9 fatias (${total}) != 1277100`);
  }
  return cents.map((allocation, i) =>
    makeAllocationRow({
      id: `ra-${i}`,
      targetExpenseId: `tgt-${i}`,
      allocation,
      plannedValorTotal: allocation,
      target: {
        id: `tgt-${i}`,
        titulo: `Item ${i + 1} da reforma`,
        fornecedor: null,
        deletedAt: null,
        project: { id: 'reforma1', name: 'Reforma Cozinha', type: 'REFORMA' },
      },
    }),
  );
}

describe('ExpenseService.getRateioDetail (GET .../rateio — contrato read-only, #423)', () => {
  let service: any;
  let prisma: any;

  function buildPrisma(opts: {
    project?: any;
    source?: any | null;
    allocations?: RateioAllocationRow[];
  }) {
    const project = opts.project ?? { id: 'reforma1', tenantId: 't1', type: 'REFORMA', deletedAt: null };
    const source = opts.source === undefined ? makeSource() : opts.source;
    const allocations = opts.allocations ?? [];

    const p: any = {
      project: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where.id === project.id && where.tenantId === project.tenantId) {
            return Promise.resolve(project);
          }
          return Promise.resolve(null);
        }),
      },
      expense: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (!source) return Promise.resolve(null);
          const idOk = where.id === source.id;
          const tenantOk = !where.tenantId || where.tenantId === source.tenantId;
          const projectOk = !where.projectId || where.projectId === source.projectId;
          if (idOk && tenantOk && projectOk) return Promise.resolve(source);
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      rateioAllocation: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          if (where?.sourceExpenseId && where.sourceExpenseId !== source?.id) return Promise.resolve([]);
          return Promise.resolve(allocations);
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      cashFlowEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      crossProjectSettlement: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') return cb(p);
        return Promise.all(cb);
      }),
    };
    return p;
  }

  beforeEach(async () => {
    prisma = buildPrisma({ allocations: nineTelhanorteAllocations() });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        ConciliacaoService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ExpenseService);
  });

  it('happy path: 9 alocações somando EXATAMENTE o total da fonte, sobra 0', async () => {
    const res = await service.getRateioDetail('t1', 'reforma1', 'src-telhanorte');

    expect(res.sourceId).toBe('src-telhanorte');
    expect(res.totalCents).toBe(1_277_100);
    expect(res.items).toHaveLength(9);

    const allocatedSum = res.items.reduce((s: number, it: any) => s + it.allocation, 0);
    expect(allocatedSum).toBe(1_277_100);
    expect(res.allocatedCents).toBe(1_277_100);
    expect(res.sobraCents).toBe(0);

    // Formato de cada item
    const first = res.items.find((it: any) => it.targetExpenseId === 'tgt-0');
    expect(first).toMatchObject({
      targetExpenseId: 'tgt-0',
      titulo: 'Item 1 da reforma',
      allocation: 142_400,
      plannedValorTotal: 142_400,
    });
    expect(first.project).toMatchObject({ id: 'reforma1', name: 'Reforma Cozinha', type: 'REFORMA' });
  });

  it('NÃO reproduz o bug do "só primeiro alvo": expõe as 9 despesas, não só a canônica (linkedExpenseId)', async () => {
    // A fonte, no mundo real, tem linkedExpenseId apontando SÓ para o primeiro
    // alvo (tgt-0) — é exatamente esse o vínculo insuficiente que a issue quer
    // substituir. O endpoint de leitura NUNCA pode derivar a lista a partir de
    // linkedExpenseId: precisa vir de RateioAllocation.
    prisma = buildPrisma({
      source: makeSource({ linkedExpenseId: 'tgt-0' }),
      allocations: nineTelhanorteAllocations(),
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExpenseService);

    const res = await service.getRateioDetail('t1', 'reforma1', 'src-telhanorte');
    const ids = res.items.map((it: any) => it.targetExpenseId).sort();
    expect(ids).toEqual(
      Array.from({ length: 9 }, (_, i) => `tgt-${i}`).sort(),
    );
    // nenhuma referência residual a linkedExpenseId no payload
    expect(res).not.toHaveProperty('linkedExpenseId');
  });

  it('boundary 0: fonte sem NENHUMA RateioAllocation → 404 (NotFoundException)', async () => {
    prisma = buildPrisma({ allocations: [] });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExpenseService);

    await expect(service.getRateioDetail('t1', 'reforma1', 'src-telhanorte')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('boundary 1: exatamente UMA alocação → 1 item, totalCents = allocation, sobra 0', async () => {
    prisma = buildPrisma({
      source: makeSource({ valorTotal: 50_000 }),
      allocations: [
        makeAllocationRow({ id: 'ra-0', targetExpenseId: 'tgt-0', allocation: 50_000, plannedValorTotal: 50_000 }),
      ],
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExpenseService);

    const res = await service.getRateioDetail('t1', 'reforma1', 'src-telhanorte');
    expect(res.items).toHaveLength(1);
    expect(res.totalCents).toBe(50_000);
    expect(res.allocatedCents).toBe(50_000);
    expect(res.sobraCents).toBe(0);
  });

  it('tenant scoping: sourceId de OUTRO tenant → 404, mesmo com o mesmo id', async () => {
    await expect(service.getRateioDetail('tenant-invasor', 'reforma1', 'src-telhanorte')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // não deve nem chegar a olhar as allocations de outro tenant
    expect(prisma.rateioAllocation.findMany).not.toHaveBeenCalled();
  });

  it('projectId de outro projeto (mesmo tenant) → 404 (fonte não pertence ao projeto informado)', async () => {
    await expect(service.getRateioDetail('t1', 'outro-projeto', 'src-telhanorte')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('alvo removido (soft-deleted): mantém a soma das alocações e sinaliza o item como removido, sem quebrar', async () => {
    const rows = nineTelhanorteAllocations();
    rows[3] = { ...rows[3], target: { ...rows[3].target!, deletedAt: new Date('2026-08-01') } };
    prisma = buildPrisma({ allocations: rows });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExpenseService);

    const res = await service.getRateioDetail('t1', 'reforma1', 'src-telhanorte');
    // a soma NÃO muda: dinheiro não pode sumir do consolidado só porque o
    // alvo foi removido depois — a allocation ainda é a verdade do rateio.
    expect(res.items).toHaveLength(9);
    expect(res.allocatedCents).toBe(1_277_100);
    expect(res.sobraCents).toBe(0);

    const removedItem = res.items.find((it: any) => it.targetExpenseId === 'tgt-3');
    expect(removedItem.targetRemoved).toBe(true);
  });

  it('GET é read-only: NUNCA dispara update/upsert/delete ao consultar o detalhe', async () => {
    await service.getRateioDetail('t1', 'reforma1', 'src-telhanorte');

    expect(prisma.expense.update).not.toHaveBeenCalled();
    expect(prisma.expense.updateMany).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.upsert).not.toHaveBeenCalled();
    expect(prisma.rateioAllocation.delete).not.toHaveBeenCalled();
    expect(prisma.cashFlowEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.cashFlowEntry.updateMany).not.toHaveBeenCalled();
  });

  it('rateia em 2 planejadas (fora do cenário Telhanorte): soma ainda fecha e ambos aparecem', async () => {
    prisma = buildPrisma({
      source: makeSource({ valorTotal: 100_000 }),
      allocations: [
        makeAllocationRow({ id: 'ra-a', targetExpenseId: 'pisos', allocation: 32_000, plannedValorTotal: 30_000 }),
        makeAllocationRow({ id: 'ra-b', targetExpenseId: 'louca', allocation: 68_000, plannedValorTotal: 70_000 }),
      ],
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseService, ConciliacaoService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExpenseService);

    const res = await service.getRateioDetail('t1', 'reforma1', 'src-telhanorte');
    expect(res.items).toHaveLength(2);
    expect(res.allocatedCents).toBe(100_000);
    expect(res.sobraCents).toBe(0);
    const pisos = res.items.find((it: any) => it.targetExpenseId === 'pisos');
    const louca = res.items.find((it: any) => it.targetExpenseId === 'louca');
    // plannedValorTotal é o ORIGINAL do alvo (imutável) — DIFERENTE da allocation
    expect(pisos.plannedValorTotal).toBe(30_000);
    expect(pisos.allocation).toBe(32_000);
    expect(louca.plannedValorTotal).toBe(70_000);
    expect(louca.allocation).toBe(68_000);
  });
});
