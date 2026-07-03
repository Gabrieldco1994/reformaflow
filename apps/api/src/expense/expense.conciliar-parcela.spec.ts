import { Test, TestingModule } from '@nestjs/testing';
import { ExpenseService } from './expense.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';

describe('ExpenseService.conciliarParcela — hardening', () => {
  let service: ExpenseService;
  let prisma: any;
  let conciliacao: any;

  const tenantId = 't1';
  const projectId = 'pessoal1';

  function buildSource(over: Partial<any> = {}) {
    // ESPELHO parcelado p/ discriminar: slice=11000, valorTotal=22000.
    return {
      id: 'src', tenantId, projectId, deletedAt: null, valorTotal: 22000,
      formaPagamento: 'PARCELADO', dataPagamento: null, quantidadeParcela: 2,
      dataInicioParcela: new Date('2026-05-10'), status: 'PAGO', paidParcelas: null,
      tipoDespesa: 'OUTROS', linkedExpenseId: null, ...over,
    };
  }

  beforeEach(async () => {
    prisma = {
      project: { findFirst: jest.fn().mockResolvedValue({ id: projectId, tenantId, deletedAt: null }) },
      expense: { findFirst: jest.fn().mockResolvedValue(buildSource()) },
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn({ /* tx */ })),
    };
    conciliacao = { settleTargetParcela: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConciliacaoService, useValue: conciliacao },
      ],
    }).compile();
    service = module.get(ExpenseService);
  });

  it('P4: realValor default = valorTotal do ESPELHO (não o slice da source)', async () => {
    await service.conciliarParcela(tenantId, projectId, 'src', { targetExpenseId: 'tgt', parcelaIndex: 0 });
    const arg = conciliacao.settleTargetParcela.mock.calls[0][1];
    expect(arg.realValor).toBe(22000); // valorTotal do espelho, NÃO 11000 (slice)
  });

  it('E2: parcelaIndex acima do range é clampado e o RETORNO reflete o índice efetivo', async () => {
    // target 3x → índice máximo 2. Assumimos clamp único em settleTargetParcela; o retorno de
    // conciliarParcela deve expor o índice EFETIVO liquidado (não o cru 99).
    conciliacao.settleTargetParcela.mockImplementation(async (_tx: any, input: any) => {
      // simula clamp interno para 2
      input._effective = Math.min(Math.max(0, input.parcelaIndex), 2);
    });
    const res: any = await service.conciliarParcela(tenantId, projectId, 'src', { targetExpenseId: 'tgt', parcelaIndex: 99 });
    expect(res.parcelaIndex).toBe(2);
  });

  it('P5: bloqueia conciliar em despesa quando o alvo é neutro (propaga erro do settle)', async () => {
    conciliacao.settleTargetParcela.mockRejectedValue(new Error('Alvo neutro não pode ser conciliado'));
    await expect(
      service.conciliarParcela(tenantId, projectId, 'src', { targetExpenseId: 'tgt', parcelaIndex: 0 }),
    ).rejects.toThrow(/neutr/i);
  });
});
