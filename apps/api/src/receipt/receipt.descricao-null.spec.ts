import { Test, TestingModule } from '@nestjs/testing';
import { ReceiptService } from './receipt.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Regressão de borda: PATCH /receipts com `descricao: null` (Maria / clientes
 * REST) chegava ao service e fazia `null.trim()` → 500. O guard é `!== undefined`
 * (para não sobrescrever quando o campo é omitido), então null passava. Fix: `?.`.
 */
const makePrismaMock = () => {
  const mock: any = {
    project: { findFirst: jest.fn() },
    receipt: { findFirst: jest.fn(), update: jest.fn() },
    cashFlowEntry: { updateMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation(async (cb: any) => cb(mock));
  return mock;
};

describe('ReceiptService.update — descricao null (borda)', () => {
  let service: ReceiptService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    prisma.project.findFirst.mockResolvedValue({ id: 'p1', type: 'PESSOAL' });
    // bankLast4 já setado → pula o backfill/lookup de conta.
    prisma.receipt.findFirst.mockResolvedValue({ id: 'r1', bankLast4: '4247' });
    prisma.receipt.update.mockImplementation(async ({ data }: any) => ({
      id: 'r1', projectId: 'p1', tenantId: 't1', valor: 1000,
      data: new Date(), tipo: 'SALARIO', status: 'EM_CAIXA', ...data,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [ReceiptService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ReceiptService);
  });

  it('não quebra e grava descricao=null', async () => {
    await expect(
      service.update('t1', 'p1', 'r1', { descricao: null } as any),
    ).resolves.toBeDefined();
    expect(prisma.receipt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ descricao: null }) }),
    );
  });

  it('omitir descricao não toca no campo', async () => {
    await service.update('t1', 'p1', 'r1', {} as any);
    const data = prisma.receipt.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('descricao');
  });
});
